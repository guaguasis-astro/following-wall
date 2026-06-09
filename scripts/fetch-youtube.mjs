// scripts/fetch-youtube.mjs
//
// Fetch the latest video per YouTube channel via multiple strategies:
// 1. The public Atom feed: https://www.youtube.com/feeds/videos.xml?channel_id={id}
// 2. RSSHub fallback - multiple paths and hosts
// No auth, no anti-bot, no key — Google publishes this for every channel.
// Each <entry> includes media:thumbnail (cover) and published timestamp.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function fetchText(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`)
  return resp.text()
}

// Pull the first capture group of `re` out of `s`, or '' if no match.
function pick(s, re) {
  const m = s.match(re)
  return m ? m[1] : ''
}

function parseFirstEntry(xml, channelId) {
  // Author info lives outside <entry>, at the channel level.
  const author = pick(xml, /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/)

  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/)
  if (!entryMatch) throw new Error('youtube: no <entry> in feed (channel may have no public videos)')
  const entry = entryMatch[1]

  const videoId = pick(entry, /<yt:videoId>([\s\S]*?)<\/yt:videoId>/) || pick(entry, /<guid>([\s\S]*?)<\/guid>/)
  const title   = pick(entry, /<title>([\s\S]*?)<\/title>/).trim()
  const link    = pick(entry, /<link[^>]*href="([^"]+)"/)
  const published = pick(entry, /<published>([\s\S]*?)<\/published>/) || pick(entry, /<pubDate>([\s\S]*?)<\/pubDate>/)
  let summary = pick(entry, /<media:description>([\s\S]*?)<\/media:description>/) || pick(entry, /<description>([\s\S]*?)<\/description>/) || ''
  summary = summary.trim()
  // media:thumbnail is self-closing inside media:group
  const cover = pick(entry, /<media:thumbnail[^>]*url="([^"]+)"/) || pick(entry, /<itunes:image[^>]*href="([^"]+)"/) || ''

  if (!videoId && !link) throw new Error('youtube: entry missing videoId and link')

  return {
    title,
    cover,
    summary,
    link: link || (videoId ? `https://www.youtube.com/watch=${videoId.replace('yt:video:', '')}` : ''),
    publishedAt: published ? new Date(published).toISOString() : new Date().toISOString(),
    creatorName: author, // canonical channel name from feed, in case subs.name was a nickname
    creatorUrl: `https://www.youtube.com/channel/${channelId}`,
  }
}

async function fetchViaOfficialFeed(channelId) {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`)
  return parseFirstEntry(xml, channelId)
}

async function fetchViaRsshub(channelId) {
  const hosts = [
    'https://rsshub.app',
    'https://rsshub.rssforever.com',
    'https://rss.shab.fun',
    'https://rsshub.pseudoyu.com',
    'https://rsshub.feeded.app',
    'https://rsshub.henry.wang',
  ]
  const paths = [
    `/youtube/channel/${channelId}`,
    `/youtube/user/${channelId}`,
    `/youtube/videos/${channelId}`,
  ]
  let lastErr
  for (const host of hosts) {
    for (const path of paths) {
      try {
        const xml = await fetchText(`${host}${path}`)
        return parseFirstEntry(xml, channelId)
      } catch (e) {
        lastErr = e
      }
    }
  }
  throw lastErr || new Error('youtube: all rsshub hosts failed')
}

export async function fetchYoutubeLatest(subs) {
  if (!subs?.length) return []
  const out = []
  for (const { name, channelId } of subs) {
    let video = null
    const errors = []
    for (const [label, fn] of [
      ['official', () => fetchViaOfficialFeed(channelId)],
      ['rsshub', () => fetchViaRsshub(channelId)],
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
      console.warn(`  ✗ ${name} (channel=${channelId}) — all strategies failed:\n    ${errors.join('\n    ')}`)
      continue
    }
    out.push({
      platform: 'youtube',
      creator: name, // keep 瓜瓜's display name, not the feed author name
      creatorUrl: video.creatorUrl,
      creatorAvatar: '',
      title: video.title,
      cover: video.cover,
      summary: video.summary,
      link: video.link,
      publishedAt: video.publishedAt,
    })
    // gentle delay; YouTube's feed endpoint is generous but no reason to hammer
    await new Promise(r => setTimeout(r, 500))
  }
  return out
}
