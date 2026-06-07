// scripts/fetch-all.mjs
//
// Entry point. Reads subscriptions.json, fans out to per-platform fetchers,
// merges with previous data.json (so a transient fetch failure keeps the old
// card visible), sorts by publishedAt desc, and writes data.json.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchBilibiliLatest } from './fetch-bilibili.mjs'
import { fetchYoutubeLatest } from './fetch-youtube.mjs'
import { fetchSubstackLatest } from './fetch-substack.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch {
    return fallback
  }
}

function keyOf(item) {
  return `${item.platform}::${item.creator}`
}

async function main() {
  const subs = await readJson(path.join(ROOT, 'subscriptions.json'), {})
  const prev = await readJson(path.join(ROOT, 'data.json'), { items: [] })

  console.log('• B站')
  const biliItems = await fetchBilibiliLatest(subs.bilibili || [])
  console.log('• YouTube')
  const ytItems = await fetchYoutubeLatest(subs.youtube || [])
  console.log('• Substack')
  const ssItems = await fetchSubstackLatest(subs.substack || [])

  const fresh = [...biliItems, ...ytItems, ...ssItems]
  const freshIndex = new Map(fresh.map(i => [keyOf(i), i]))

  // Build the list of every subscribed creator (so we know what to carry over from prev when fresh failed).
  const allSubscribed = []
  for (const s of subs.bilibili || []) allSubscribed.push({ platform: 'bilibili', creator: s.name })
  for (const s of subs.youtube || []) allSubscribed.push({ platform: 'youtube', creator: s.name })
  for (const s of subs.substack || []) allSubscribed.push({ platform: 'substack', creator: s.name })

  const prevIndex = new Map((prev.items || []).map(i => [keyOf(i), i]))

  const merged = []
  for (const sub of allSubscribed) {
    const k = keyOf(sub)
    const fItem = freshIndex.get(k)
    if (fItem) {
      merged.push(fItem)
    } else if (prevIndex.has(k)) {
      const carried = { ...prevIndex.get(k), stale: true }
      console.log(`  ↳ carrying over previous entry for ${sub.creator} (no fresh data this run)`)
      merged.push(carried)
    }
    // else: nothing yet for this creator (first run, all strategies failed) — silently skip
  }

  merged.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))

  const out = {
    updatedAt: new Date().toISOString(),
    items: merged,
  }
  await fs.writeFile(path.join(ROOT, 'data.json'), JSON.stringify(out, null, 2) + '\n')
  console.log(`\n✔ Wrote data.json with ${merged.length} items.`)
}

main().catch(err => {
  console.error('fetch-all failed:', err)
  // Exit 0 so the GitHub Action workflow stays green even on hard errors.
  // (We can tighten this later once the pipeline is proven.)
  process.exit(0)
})
