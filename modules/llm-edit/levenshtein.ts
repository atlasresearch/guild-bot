// Standard Levenshtein distance + similarity ratio. In-house — no external dep.

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Two-row DP — O(min(a,b)) space.
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  let prev = new Array(shorter.length + 1)
  let curr = new Array(shorter.length + 1)
  for (let i = 0; i <= shorter.length; i++) prev[i] = i

  for (let i = 1; i <= longer.length; i++) {
    curr[0] = i
    const cLong = longer.charCodeAt(i - 1)
    for (let j = 1; j <= shorter.length; j++) {
      const cost = shorter.charCodeAt(j - 1) === cLong ? 0 : 1
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      )
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[shorter.length]
}

/** 1.0 = identical, 0.0 = completely different. */
export function similarityRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshteinDistance(a, b) / maxLen
}
