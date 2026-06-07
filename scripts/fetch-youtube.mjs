// scripts/fetch-youtube.mjs
//
// Placeholder for MVP. Will be implemented when 瓜瓜 provides channel IDs.
// YouTube exposes a public RSS feed per channel — no auth, no anti-bot — so this
// will be a thin XML parse over: https://www.youtube.com/feeds/videos.xml?channel_id={id}

export async function fetchYoutubeLatest(subs) {
  if (!subs?.length) return []
  console.log(`  (youtube not yet implemented — ${subs.length} subs skipped)`)
  return []
}
