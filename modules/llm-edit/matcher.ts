// Four-stage matcher cascade per plan 006 R2.2:
//   1. Exact match
//   2. Whitespace-insensitive match
//   3. Indentation-preserving match
//   4. Fuzzy Levenshtein over candidate windows
//
// Each stage returns { start, end } byte offsets into the haystack so the
// caller can splice replace text in. A successful match also reports the
// confidence score so the failure-feedback string can cite the best attempt.

import { similarityRatio } from './levenshtein'

const FUZZY_CONFIDENCE_THRESHOLD = 0.95
const FUZZY_GAP_MIN = 0.1

export type MatchHit = {
  start: number
  end: number
  /** Replacement text after any whitespace/indentation normalisation. */
  rewrittenReplace: string
  confidence: number
  stage: 'exact' | 'whitespace' | 'indentation' | 'fuzzy'
}

export type MatchMiss = {
  /** Best candidate we found, even if it didn't qualify. */
  bestConfidence: number
  /** 0-indexed line where the best candidate starts (if any). */
  bestLine?: number
  /** Snippet of what we found at the best location (for feedback). */
  bestSnippet?: string
  /** If failure was due to ambiguity, list the top two candidates. */
  ambiguousCandidates?: Array<{ line: number; snippet: string; confidence: number }>
}

export type MatchResult =
  | { ok: true; hit: MatchHit }
  | { ok: false; miss: MatchMiss }

// ── Stage 1: exact ──────────────────────────────────────────────────────────

function findExact(haystack: string, search: string, replace: string): MatchResult {
  const idx = haystack.indexOf(search)
  if (idx < 0) return { ok: false, miss: { bestConfidence: 0 } }
  const second = haystack.indexOf(search, idx + 1)
  if (second >= 0) {
    return {
      ok: false,
      miss: {
        bestConfidence: 1,
        ambiguousCandidates: [
          { line: lineOfOffset(haystack, idx), snippet: firstLine(search), confidence: 1 },
          { line: lineOfOffset(haystack, second), snippet: firstLine(search), confidence: 1 },
        ],
      },
    }
  }
  return {
    ok: true,
    hit: { start: idx, end: idx + search.length, rewrittenReplace: replace, confidence: 1, stage: 'exact' },
  }
}

// ── Stage 2: whitespace-insensitive ─────────────────────────────────────────

/**
 * Collapse all runs of whitespace to a single space, trim ends per line, but
 * preserve line boundaries (we still want \n to count). This lets the matcher
 * find a region whose only difference from `search` is interior whitespace.
 */
function normaliseWhitespace(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
}

/**
 * Map a normalised offset back to the haystack's original offset. We build a
 * parallel index during normalisation.
 */
function buildNormToOrigIndex(orig: string): { norm: string; map: number[] } {
  const norm: string[] = []
  const map: number[] = []
  let inSpace = false
  let lineStartNorm = true

  for (let i = 0; i < orig.length; i++) {
    const c = orig[i]
    if (c === '\n') {
      // strip trailing whitespace from line we just finished
      while (norm.length > 0 && (norm[norm.length - 1] === ' ' || norm[norm.length - 1] === '\t')) {
        norm.pop()
        map.pop()
      }
      norm.push('\n')
      map.push(i)
      inSpace = false
      lineStartNorm = true
      continue
    }
    if (c === ' ' || c === '\t') {
      if (lineStartNorm || inSpace) continue
      inSpace = true
      norm.push(' ')
      map.push(i)
      continue
    }
    inSpace = false
    lineStartNorm = false
    norm.push(c)
    map.push(i)
  }
  // strip trailing whitespace on the last line
  while (norm.length > 0 && (norm[norm.length - 1] === ' ' || norm[norm.length - 1] === '\t')) {
    norm.pop()
    map.pop()
  }
  // sentinel so end-of-match can map to original length
  map.push(orig.length)
  return { norm: norm.join(''), map }
}

function findWhitespaceInsensitive(haystack: string, search: string, replace: string): MatchResult {
  const { norm, map } = buildNormToOrigIndex(haystack)
  const normSearch = normaliseWhitespace(search)
  if (normSearch.length === 0) return { ok: false, miss: { bestConfidence: 0 } }

  const idx = norm.indexOf(normSearch)
  if (idx < 0) return { ok: false, miss: { bestConfidence: 0 } }
  const second = norm.indexOf(normSearch, idx + 1)
  if (second >= 0) {
    return {
      ok: false,
      miss: {
        bestConfidence: 0.98,
        ambiguousCandidates: [
          { line: lineOfOffset(haystack, map[idx]), snippet: firstLine(search), confidence: 0.98 },
          { line: lineOfOffset(haystack, map[second]), snippet: firstLine(search), confidence: 0.98 },
        ],
      },
    }
  }
  const origStart = map[idx]
  const origEnd = map[idx + normSearch.length] ?? haystack.length
  return {
    ok: true,
    hit: { start: origStart, end: origEnd, rewrittenReplace: replace, confidence: 0.98, stage: 'whitespace' },
  }
}

// ── Stage 3: indentation-preserving ─────────────────────────────────────────

function dedentLines(s: string): { dedented: string; indents: string[] } {
  const lines = s.split('\n')
  const indents: string[] = []
  const dedented = lines
    .map((line) => {
      const m = line.match(/^[ \t]*/)
      indents.push(m ? m[0] : '')
      return line.slice(m ? m[0].length : 0)
    })
    .join('\n')
  return { dedented, indents }
}

function reindent(replace: string, baseIndent: string): string {
  const lines = replace.split('\n')
  return lines
    .map((line, i) => {
      // First line gets baseIndent prepended only if the SEARCH's first line had
      // indentation in the haystack. For other lines, preserve their RELATIVE
      // indentation by adding baseIndent.
      if (line.length === 0) return line
      return (i === 0 ? baseIndent : baseIndent) + line
    })
    .join('\n')
}

function findIndentationPreserving(
  haystack: string,
  search: string,
  replace: string,
): MatchResult {
  const { dedented: dedentSearch } = dedentLines(search)
  if (dedentSearch.trim().length === 0) return { ok: false, miss: { bestConfidence: 0 } }

  const haystackLines = haystack.split('\n')
  const searchLines = dedentSearch.split('\n')

  let firstHit: { lineIdx: number; baseIndent: string } | undefined
  let secondHit: { lineIdx: number; baseIndent: string } | undefined

  outer: for (let i = 0; i + searchLines.length <= haystackLines.length; i++) {
    // Detect the common indentation of the haystack window so we can reuse it.
    const firstHayLine = haystackLines[i]
    const indentMatch = firstHayLine.match(/^[ \t]*/)
    const baseIndent = indentMatch ? indentMatch[0] : ''
    for (let j = 0; j < searchLines.length; j++) {
      const hayLine = haystackLines[i + j]
      const hayDedented = hayLine.startsWith(baseIndent) ? hayLine.slice(baseIndent.length) : hayLine.replace(/^[ \t]*/, '')
      if (hayDedented !== searchLines[j]) continue outer
    }
    if (!firstHit) firstHit = { lineIdx: i, baseIndent }
    else if (!secondHit) {
      secondHit = { lineIdx: i, baseIndent }
      break
    }
  }

  if (!firstHit) return { ok: false, miss: { bestConfidence: 0 } }
  if (secondHit) {
    return {
      ok: false,
      miss: {
        bestConfidence: 0.95,
        ambiguousCandidates: [
          { line: firstHit.lineIdx, snippet: firstLine(haystackLines[firstHit.lineIdx]), confidence: 0.95 },
          { line: secondHit.lineIdx, snippet: firstLine(haystackLines[secondHit.lineIdx]), confidence: 0.95 },
        ],
      },
    }
  }

  // Compute byte offset
  const startOffset = offsetOfLine(haystack, firstHit.lineIdx)
  const endLineIdx = firstHit.lineIdx + searchLines.length - 1
  const endOffset = offsetOfLine(haystack, endLineIdx) + haystackLines[endLineIdx].length
  return {
    ok: true,
    hit: {
      start: startOffset,
      end: endOffset,
      rewrittenReplace: reindent(replace, firstHit.baseIndent),
      confidence: 0.95,
      stage: 'indentation',
    },
  }
}

// ── Stage 4: fuzzy Levenshtein over candidate windows ──────────────────────

function findFuzzy(
  haystack: string,
  search: string,
  replace: string,
  startLineHint?: number,
): MatchResult {
  const haystackLines = haystack.split('\n')
  const searchLines = search.split('\n')
  const windowSize = searchLines.length
  if (windowSize === 0 || haystackLines.length < windowSize) {
    return { ok: false, miss: { bestConfidence: 0 } }
  }

  // Determine the range of window starts to try.
  let minStart = 0
  let maxStart = haystackLines.length - windowSize
  if (typeof startLineHint === 'number') {
    const hint = startLineHint - 1 // 1-based → 0-based
    minStart = Math.max(0, hint - 10)
    maxStart = Math.min(haystackLines.length - windowSize, hint + 10)
  }

  let best = { confidence: 0, start: -1 }
  let secondBest = { confidence: 0, start: -1 }

  for (let i = minStart; i <= maxStart; i++) {
    const windowText = haystackLines.slice(i, i + windowSize).join('\n')
    const conf = similarityRatio(windowText, search)
    if (conf > best.confidence) {
      secondBest = best
      best = { confidence: conf, start: i }
    } else if (conf > secondBest.confidence) {
      secondBest = { confidence: conf, start: i }
    }
  }

  if (best.confidence < FUZZY_CONFIDENCE_THRESHOLD) {
    return {
      ok: false,
      miss: {
        bestConfidence: best.confidence,
        bestLine: best.start,
        bestSnippet: best.start >= 0 ? firstLine(haystackLines[best.start]) : undefined,
      },
    }
  }
  if (best.confidence - secondBest.confidence < FUZZY_GAP_MIN && secondBest.start >= 0) {
    return {
      ok: false,
      miss: {
        bestConfidence: best.confidence,
        ambiguousCandidates: [
          { line: best.start, snippet: firstLine(haystackLines[best.start]), confidence: best.confidence },
          { line: secondBest.start, snippet: firstLine(haystackLines[secondBest.start]), confidence: secondBest.confidence },
        ],
      },
    }
  }

  const startOffset = offsetOfLine(haystack, best.start)
  const endLineIdx = best.start + windowSize - 1
  const endOffset = offsetOfLine(haystack, endLineIdx) + haystackLines[endLineIdx].length
  return {
    ok: true,
    hit: {
      start: startOffset,
      end: endOffset,
      rewrittenReplace: replace,
      confidence: best.confidence,
      stage: 'fuzzy',
    },
  }
}

// ── Cascade orchestration ──────────────────────────────────────────────────

export function findMatch(
  haystack: string,
  search: string,
  replace: string,
  startLine?: number,
): MatchResult {
  // We track the best miss we've seen for feedback purposes.
  let bestMiss: MatchMiss = { bestConfidence: 0 }
  const tryStage = (r: MatchResult): MatchResult | undefined => {
    if (r.ok) return r
    if (r.miss.ambiguousCandidates) return r // ambiguity is final — don't escalate
    if (r.miss.bestConfidence > bestMiss.bestConfidence) bestMiss = r.miss
    return undefined
  }

  return (
    tryStage(findExact(haystack, search, replace)) ??
    tryStage(findWhitespaceInsensitive(haystack, search, replace)) ??
    tryStage(findIndentationPreserving(haystack, search, replace)) ??
    tryStage(findFuzzy(haystack, search, replace, startLine)) ?? { ok: false, miss: bestMiss }
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function lineOfOffset(text: string, offset: number): number {
  let line = 0
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

function offsetOfLine(text: string, lineIdx: number): number {
  let off = 0
  for (let l = 0; l < lineIdx; l++) {
    const nl = text.indexOf('\n', off)
    if (nl < 0) return text.length
    off = nl + 1
  }
  return off
}

function firstLine(s: string): string {
  const nl = s.indexOf('\n')
  return nl < 0 ? s : s.slice(0, nl)
}
