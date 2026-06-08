// scripts/fetch-youtube.mjs
//
// Fetch the latest video per YouTube channel via the public Atom feed:
//   https://www.youtube.com/feeds/videos.xml?channel_id={id}
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

  const videoId = pick(entry, /<yt:videoId>([\s\S]*?)<\/yt:videoId>/)
  const title   = pick(entry, /<title>([\s\S]*?)<\/title>/).trim()
  const link    = pick(entry, /<link[^>]*href="([^"]+)"/)
  const published = pick(entry, /<published>([\s\S]*?)<\/published>/)
  let summary = pick(entry, /<media:description>([\s\S]*?)<\/media:description>/) || ''
  summary = summary.trim()
  // media:thumbnail is self-closing inside media:group
  const cover = pick(entry, /<media:thumbnail[^>]*url="([^"]+)"/)

  if (!videoId) throw new Error('youtube: entry missing videoId')

  return {
    title,
    cover,
    summary,
    link: link || `https://www.youtube.com/watch?v=${videoId}`,
    publishedAt: published ? new Date(published).toISOString() : new Date().toISOString(),
    creatorName: author, // canonical channel name from feed, in case subs.name was a nickname
    creatorUrl: `https://www.youtube.com/channel/${channelId}`,
  }
}

export async function fetchYoutubeLatest(subs) {
  if (!subs?.length) return []
  const out = []
  for (const { name, channelId } of subs) {
    try {
      const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`)
      const v = parseFirstEntry(xml, channelId)
      console.log(`  ✓ ${name}: ${v.title}`)
      out.push({
        platform: 'youtube',
        creator: name, // keep 瓜瓜's display name, not the feed author name
        creatorUrl: v.creatorUrl,
        creatorAvatar: '',
        title: v.title,
        cover: v.cover,
        summary: v.summary,
        link: v.link,
        publishedAt: v.publishedAt,
      })
    } catch (e) {
      console.warn(`  ✗ ${name} (channel=${channelId}): ${e.message}`)
    }
    // gentle delay; YouTube's feed endpoint is generous but no reason to hammer
    await new Promise(r => setTimeout(r, 300))
  }
  return out
}
