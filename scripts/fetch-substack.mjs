// scripts/fetch-substack.mjs
//
// Placeholder for MVP. Will be implemented when 瓜瓜 provides publication subdomains.
// Substack exposes a public RSS feed per publication: https://{name}.substack.com/feed

export async function fetchSubstackLatest(subs) {
  if (!subs?.length) return []
  console.log(`  (substack not yet implemented — ${subs.length} subs skipped)`)
  return []
}
