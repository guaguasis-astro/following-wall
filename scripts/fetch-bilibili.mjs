// scripts/fetch-bilibili.mjs
//
// Fetch the latest video for each B站 UP 主.
// Tries 3 strategies in order; first one that works wins:
//   A) WBI-signed `x/space/wbi/arc/search` (official, needs nav-derived img_key/sub_key)
//   B) `x/polymer/web-dynamic/v1/feed/space` (dynamic feed, no WBI but needs Buvid3 cookie)
//   C) RSSHub public instance fallback
//
// Each strategy is allowed to fail; on total failure we return null for that UID
// and the entry-point script will keep the previous data.json entry for that creator.

import crypto from 'node:crypto'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Mixin table used by B站 WBI signing. Source: leaked from biliplus / SocialSisterYi/bilibili-API-collect.
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

// ──────────────────────────── shared http helpers ────────────────────────────

async function fetchJson(url, { headers = {}, cookieJar } = {}) {
  const finalHeaders = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    ...headers,
  }
  if (cookieJar && cookieJar.size) {
    finalHeaders.Cookie = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  const resp = await fetch(url, { headers: finalHeaders })
  // collect any Set-Cookie into the jar
  if (cookieJar) {
    for (const [name, value] of resp.headers) {
      if (name.toLowerCase() === 'set-cookie') {
        for (const cookieLine of value.split(/,(?=[^;]+=)/)) {
          const [pair] = cookieLine.split(';')
          const eq = pair.indexOf('=')
          if (eq > 0) cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
        }
      }
    }
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`)
  return resp.json()
}

async function fetchText(url, opts = {}) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`)
  return resp.text()
}

// Hit the home page once so we get a Buvid3 cookie issued, used by both A and B.
// If env BILI_SESSDATA is provided, we attach it so requests look like a logged-in
// user — this is the only reliable way to bypass datacenter-IP risk control.
async function primeCookieJar() {
  const jar = new Map()
  // Synthetic Buvid3 is also acceptable to most endpoints; do both for safety.
  jar.set('buvid3', crypto.randomUUID().toUpperCase() + 'infoc')
  jar.set('b_nut', String(Math.floor(Date.now() / 1000)))

  // Login cookies (provided via env / GitHub Secret). SESSDATA alone is enough
  // for read-only endpoints; bili_jct is needed for write actions (we don't do any).
  // Trim and strip stray quotes — GitHub Secrets sometimes get pasted with surrounding spaces / newlines.
  const rawSessdata = process.env.BILI_SESSDATA || ''
  const sessdata = rawSessdata.trim().replace(/^["']|["']$/g, '')

  // Diagnostic (length only, never the value itself) so we can tell from CI logs
  // whether the env var is reaching the script at all.
  console.log(`  (BILI_SESSDATA env: raw_len=${rawSessdata.length} trimmed_len=${sessdata.length})`)

  if (sessdata) {
    jar.set('SESSDATA', sessdata)
    if (process.env.BILI_BILI_JCT) jar.set('bili_jct', process.env.BILI_BILI_JCT.trim())
    if (process.env.BILI_BUVID3)   jar.set('buvid3', process.env.BILI_BUVID3.trim())
    if (process.env.BILI_DEDEUSERID) jar.set('DedeUserID', process.env.BILI_DEDEUSERID.trim())
    console.log('  (using logged-in SESSDATA from env)')
  }

  try {
    await fetchJson('https://api.bilibili.com/x/web-interface/nav', { cookieJar: jar })
  } catch {
    /* nav often returns -101 not-logged-in, but that's fine — we just want set-cookie */
  }
  return jar
}

// ──────────────────────────── strategy A: WBI ────────────────────────────

function getMixinKey(orig) {
  let result = ''
  for (const idx of MIXIN_KEY_ENC_TAB) result += orig[idx]
  return result.slice(0, 32)
}

async function getWbiKeys(cookieJar) {
  const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav', { cookieJar })
  const imgUrl = nav?.data?.wbi_img?.img_url || ''
  const subUrl = nav?.data?.wbi_img?.sub_url || ''
  const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1).split('.')[0]
  const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1).split('.')[0]
  if (!imgKey || !subKey) throw new Error('WBI keys missing in nav response')
  return { imgKey, subKey }
}

function encWbi(params, { imgKey, subKey }) {
  const mixinKey = getMixinKey(imgKey + subKey)
  const wts = Math.floor(Date.now() / 1000)
  const merged = { ...params, wts }
  // sanitise values (remove forbidden chars) and sort keys
  const sortedKeys = Object.keys(merged).sort()
  const query = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(merged[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex')
  return `${query}&w_rid=${w_rid}`
}

async function strategyWbi(uid, cookieJar) {
  const wbi = await getWbiKeys(cookieJar)
  const query = encWbi({ mid: uid, ps: 1, pn: 1, order: 'pubdate', platform: 'web', web_location: 1550101 }, wbi)
  const url = `https://api.bilibili.com/x/space/wbi/arc/search?${query}`
  const json = await fetchJson(url, { cookieJar })
  if (json.code !== 0) throw new Error(`B站 wbi code=${json.code} msg=${json.message}`)
  const vlist = json?.data?.list?.vlist || []
  if (!vlist.length) throw new Error('B站 wbi: vlist empty')
  const v = vlist[0]
  return {
    title: v.title,
    cover: normalizeCover(v.pic),
    link: `https://www.bilibili.com/video/${v.bvid}`,
    publishedAt: new Date(v.created * 1000).toISOString(),
  }
}

// ──────────────────────────── strategy B: dynamic feed ────────────────────────────

async function strategyDynamic(uid, cookieJar) {
  const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${uid}&offset=&platform=web`
  const json = await fetchJson(url, {
    cookieJar,
    headers: { Referer: `https://space.bilibili.com/${uid}/dynamic` },
  })
  if (json.code !== 0) throw new Error(`dynamic code=${json.code} msg=${json.message}`)
  const items = json?.data?.items || []
  const av = items.find(i => i.type === 'DYNAMIC_TYPE_AV')
  if (!av) throw new Error('dynamic: no AV item in first page')
  const archive = av?.modules?.module_dynamic?.major?.archive
  if (!archive) throw new Error('dynamic: archive block missing')
  const pubTs = av?.modules?.module_author?.pub_ts
  return {
    title: archive.title,
    cover: normalizeCover(archive.cover),
    link: archive.jump_url?.startsWith('//') ? `https:${archive.jump_url}` : archive.jump_url,
    publishedAt: pubTs ? new Date(pubTs * 1000).toISOString() : new Date().toISOString(),
  }
}

// ──────────────────────────── strategy C: RSSHub ────────────────────────────

async function strategyRsshub(uid) {
  const hosts = [
    'https://rsshub.app',
    'https://rsshub.rssforever.com',
    'https://rss.shab.fun',
    'https://rsshub.pseudoyu.com',
  ]
  let lastErr
  for (const host of hosts) {
    try {
      const xml = await fetchText(`${host}/bilibili/user/video/${uid}`)
      // crude XML extraction — first <item>
      const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/)
      if (!itemMatch) throw new Error('rsshub: no <item>')
      const block = itemMatch[1]
      const pick = (tag) => {
        const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
        if (!m) return ''
        return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim()
      }
      const link = pick('link')
      const title = pick('title')
      const pubDate = pick('pubDate')
      const desc = pick('description')
      const coverMatch = desc.match(/<img[^>]+src="([^"]+)"/i)
      return {
        title,
        cover: coverMatch ? coverMatch[1] : '',
        link,
        publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('rsshub: all hosts failed')
}

// ──────────────────────────── creator profile (avatar) ────────────────────────────
// We intentionally don't fetch avatars — B站's profile endpoints have stricter
// risk control than the video endpoints, and the page design doesn't show them.
// Kept as a stub so the orchestrator interface stays consistent.

async function fetchCreatorMeta(/* uid, cookieJar */) {
  return { avatar: '', name: '' }
}

// ──────────────────────────── orchestrator ────────────────────────────

function normalizeCover(url) {
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  return url.replace(/^http:/, 'https:')
}

// Deterministically shuffle `arr` by a string seed — so each CI run rotates which UP
// goes first. B站 lets the first 2-3 requests through then 412s the rest, so over
// several runs every UP eventually lands in a "lucky" slot.
function shuffleBySeed(arr, seed) {
  const a = arr.slice()
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  for (let i = a.length - 1; i > 0; i--) {
    h = (h * 1664525 + 1013904223) >>> 0
    const j = h % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export async function fetchBilibiliLatest(subs) {
  const out = []
  // Rotate order per run so different UPs get the "first 2 slots" each time.
  // Daily seed = YYYYMMDDHH (so a same-day rerun keeps the same order, which
  // helps debugging, but tomorrow's cron picks a new permutation).
  const seed = new Date().toISOString().slice(0, 13)
  const ordered = shuffleBySeed(subs, seed)
  console.log(`  (run order: ${ordered.map(s => s.name).join(' → ')})`)

  for (const sub of ordered) {
    const { name, uid } = sub
    const creatorUrl = `https://space.bilibili.com/${uid}`
    let video = null
    const errors = []
    // CRITICAL: fresh cookie jar per UP. B站 412s after ~2-3 requests on the
    // same session, regardless of inter-request delay. A new jar = new buvid3
    // = new session in their eyes, even though SESSDATA still identifies us.
    const jar = await primeCookieJar()
    for (const [label, fn] of [
      ['wbi', () => strategyWbi(uid, jar)],
      ['dynamic', () => strategyDynamic(uid, jar)],
      ['rsshub', () => strategyRsshub(uid)],
    ]) {
      try {
        video = await fn()
        console.log(`  ✓ ${name} via ${label}: ${video.title}`)
        break
      } catch (e) {
        errors.push(`${label}: ${e.message}`)
      }
    }
    if (!video) {
      console.warn(`  ✗ ${name} (uid=${uid}) — all strategies failed:\n    ${errors.join('\n    ')}`)
      continue
    }
    const meta = await fetchCreatorMeta(uid, jar)
    out.push({
      platform: 'bilibili',
      creator: name,
      creatorUrl,
      creatorAvatar: meta.avatar,
      title: video.title,
      cover: video.cover,
      link: video.link,
      publishedAt: video.publishedAt,
    })
    // Politeness delay between UPs — still useful even with fresh sessions,
    // to spread the requests so B站's IP-level rate window doesn't trip either.
    await new Promise(r => setTimeout(r, 4000))
  }
  return out
}
