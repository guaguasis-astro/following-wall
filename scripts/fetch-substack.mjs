// scripts/fetch-substack.mjs
//
// Fetch the latest post per Substack publication via the public RSS feed.
// Substack exposes /feed on both standard *.substack.com domains AND on
// custom domains (e.g. letters.thedankoe.com/feed), so we just take a feedUrl
// from subscriptions.json verbatim and don't try to infer it.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function fetchText(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' } })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`)
  return resp.text()
}

function unwrapCdata(s) {
  return (s || '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim()
}

function pick(s, tag) {
  const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
  return m ? unwrapCdata(m[1]) : ''
}

function deriveCreatorUrl(feedUrl) {
  // feedUrl is like https://foo.substack.com/feed or https://letters.example.com/feed
  // creator page = same origin, no path.
  try {
    const u = new URL(feedUrl)
    return `${u.protocol}//${u.host}/`
  } catch {
    return feedUrl
  }
}

function parseFirstItem(xml, feedUrl) {
  const channelTitle = pick(xml.replace(/<item[\s\S]*$/, ''), 'title')

  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/)
  if (!itemMatch) throw new Error('substack: no <item> in feed')
  const item = itemMatch[1]

  const title   = pick(item, 'title')
  const link    = pick(item, 'link')
  const pubDate = pick(item, 'pubDate')
  // Substack puts a full HTML post body inside <content:encoded>; first <img> there
  // is almost always the post cover (or at least a representative image).
  const content = pick(item, 'content:encoded') || pick(item, 'description')
  const enclosureUrl = (item.match(/<enclosure[^>]*url="([^"]+)"/) || [])[1] || ''
  const imgInContent = (content.match(/<img[^>]+src="([^"]+)"/i) || [])[1] || ''
  const cover = enclosureUrl || imgInContent

  return {
    title,
    cover,
    link,
    publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    creatorUrl: deriveCreatorUrl(feedUrl),
    channelTitle,
  }
}

export async function fetchSubstackLatest(subs) {
  if (!subs?.length) return []
  const out = []
  for (const { name, feedUrl } of subs) {
    try {
      const xml = await fetchText(feedUrl)
      const v = parseFirstItem(xml, feedUrl)
      console.log(`  ✓ ${name}: ${v.title}`)
      out.push({
        platform: 'substack',
        creator: name,
        creatorUrl: v.creatorUrl,
        creatorAvatar: '',
        title: v.title,
        cover: v.cover,
        link: v.link,
        publishedAt: v.publishedAt,
      })
    } catch (e) {
      console.warn(`  ✗ ${name} (${feedUrl}): ${e.message}`)
    }
    await new Promise(r => setTimeout(r, 300))
  }
  return out
}
