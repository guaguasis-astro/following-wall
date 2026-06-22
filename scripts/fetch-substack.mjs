// scripts/fetch-substack.mjs
//
// Fetch the latest post per Substack publication.
// Tries 3 strategies in order; first one that works wins:
//   A) Substack internal JSON API (/api/v1/archive) — different WAF rules than /feed
//   B) RSS /feed with Feedly UA
//   C) r.jina.ai Reader proxy — fetches the page server-side from a whitelisted IP,
//      returning markdown we then parse loosely
//
// Why three: Substack's /feed has a WAF rule that 403s most non-Feedly-IP requests.
// The internal /api/v1/archive endpoint is what their own React frontend uses, so
// it's tuned for browsers (more permissive UA-wise). Jina is the safety net — its
// IPs are widely trusted and it does the fetch on our behalf.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ──────────────────────────── shared helpers ────────────────────────────

function deriveOrigin(feedUrl) {
  try {
    const u = new URL(feedUrl)
    return `${u.protocol}//${u.host}`
  } catch {
    return feedUrl.replace(/\/feed\/?$/, '')
  }
}

function deriveCreatorUrl(feedUrl) {
  return `${deriveOrigin(feedUrl)}/`
}

function unwrapCdata(s) {
  return (s || '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim()
}

function pick(s, tag) {
  const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
  return m ? unwrapCdata(m[1]) : ''
}

// ──────────────────────────── strategy A: JSON API ────────────────────────────

async function strategyApi(feedUrl) {
  const origin = deriveOrigin(feedUrl)
  const url = `${origin}/api/v1/archive?sort=new&search=&offset=0&limit=1`
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: `${origin}/archive`,
      Origin: origin,
    },
  })
  if (!resp.ok) throw new Error(`api HTTP ${resp.status}`)
  const arr = await resp.json()
  if (!Array.isArray(arr) || !arr.length) throw new Error('api: empty response')
  const p = arr[0]
  const summary = p.subtitle || ''
  return {
    title: p.title || '(无标题)',
    cover: p.cover_image || '',
    summary,
    link: p.canonical_url || `${origin}/p/${p.slug}`,
    publishedAt: p.post_date ? new Date(p.post_date).toISOString() : new Date().toISOString(),
    creatorUrl: deriveCreatorUrl(feedUrl),
  }
}

// ──────────────────────────── strategy B: RSS with Feedly UA ────────────────────────────

const FEEDLY_UA = 'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)'

async function strategyRss(feedUrl) {
  const resp = await fetch(feedUrl, {
    headers: {
      'User-Agent': FEEDLY_UA,
      Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  if (!resp.ok) throw new Error(`rss HTTP ${resp.status}`)
  const xml = await resp.text()
  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/)
  if (!itemMatch) throw new Error('rss: no <item>')
  const item = itemMatch[1]
  const title = pick(item, 'title')
  const link = pick(item, 'link')
  const pubDate = pick(item, 'pubDate')
  const content = pick(item, 'content:encoded') || pick(item, 'description')
  let summary = pick(item, 'description') || ''
  // Strip HTML tags from description to get plain text summary
  summary = summary.replace(/<[^>]+>/g, '').trim()
  const enclosureUrl = (item.match(/<enclosure[^>]*url="([^"]+)"/) || [])[1] || ''
  const imgInContent = (content.match(/<img[^>]+src="([^"]+)"/i) || [])[1] || ''
  return {
    title,
    cover: enclosureUrl || imgInContent,
    summary,
    link,
    publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    creatorUrl: deriveCreatorUrl(feedUrl),
  }
}

// ──────────────────────────── strategy C: Jina Reader proxy ────────────────────────────
//
// r.jina.ai fetches the target URL server-side and returns clean markdown.
// We point it at /archive (the publication's post list page), then parse the first
// post link from the markdown. Cover image isn't easily extractable this way, but
// title + link + a rough timestamp is usually enough to render a card.

async function strategyJina(feedUrl) {
  const origin = deriveOrigin(feedUrl)
  const target = `${origin}/archive`
  // r.jina.ai is invoked by appending the target URL to its origin.
  const proxied = `https://r.jina.ai/${target}`
  const resp = await fetch(proxied) // No custom headers at all
  if (!resp.ok) throw new Error(`jina HTTP ${resp.status}`)
  const md = await resp.text()
  // First post link looks like: [Some Title](https://foo.substack.com/p/slug)
  // We want the first one whose URL contains '/p/' (i.e., a real post, not nav).
  const lines = md.split('\n')
  let title = '', link = '', summary = ''
  let titleFound = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!titleFound) {
      const m = line.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+\/p\/[^\s)]+)\)/)
      if (m) { title = m[1].trim(); link = m[2]; titleFound = true; continue }
    }
    if (titleFound && line.length > 0 && !line.startsWith('http') && !line.startsWith('[http')) {
      // Accumulate lines until we hit a blank line or another link line
      if (summary.length > 0) summary += ' '
      summary += line
      if (summary.length > 200) break
    }
  }
  if (!link) throw new Error('jina: no /p/ link in archive page')

  // If no summary found, use a fallback summary
  if (!summary || summary.trim() === '') {
    summary = '最新文章'
  }

  // Clean up Markdown in summary: remove [text](url) links, brackets, etc.
  let cleanSummary = summary
  cleanSummary = cleanSummary.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // remove [text](url)
  cleanSummary = cleanSummary.replace(/\[([^\]]+)\]/g, '$1') // remove standalone [brackets]
  cleanSummary = cleanSummary.replace(/\*\*/g, '') // remove bold
  cleanSummary = cleanSummary.replace(/\*/g, '') // remove italics

  // No cover = pure text card is fine ✍️
  return {
    title,
    cover: '',
    summary: cleanSummary,
    link,
    publishedAt: new Date().toISOString(), // unknown — best-effort, will show 'just now'
    creatorUrl: deriveCreatorUrl(feedUrl),
  }
}

// ──────────────────────────── orchestrator ────────────────────────────

export async function fetchSubstackLatest(subs) {
  if (!subs?.length) return []
  const out = []
  for (const { name, feedUrl } of subs) {
    let post = null
    const errors = []
    for (const [label, fn] of [
      ['api', () => strategyApi(feedUrl)],
      ['rss', () => strategyRss(feedUrl)],
      ['jina', () => strategyJina(feedUrl)],
    ]) {
      try {
        post = await fn()
        console.log(`  ✓ ${name} via ${label}: ${post.title}`)
        break
      } catch (e) {
        errors.push(`${label}: ${e.message}`)
      }
    }
    if (!post) {
      console.warn(`  ✗ ${name} (${feedUrl}) — all strategies failed:\n    ${errors.join('\n    ')}`)
      continue
    }
    out.push({
      platform: 'substack',
      creator: name,
      creatorUrl: post.creatorUrl,
      creatorAvatar: '',
      title: post.title,
      cover: post.cover,
      summary: post.summary,
      link: post.link,
      publishedAt: post.publishedAt,
    })
    await new Promise(r => setTimeout(r, 500))
  }
  return out
}
