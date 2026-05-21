import { findMatch, type MatchMiss } from './matcher'
import type { ApplyOptions, ApplyResult, Edit } from './types'

/**
 * Apply edits to a string. Pure function — does NOT touch the filesystem.
 *
 * Per plan 006 R2:
 *   - search-replace blocks apply sequentially against the running content
 *   - if any block fails, the call returns failure with the original content
 *     visible nowhere (no partial application)
 *   - optional validator runs on the final content; throw to reject
 *   - failure result.error follows the stable format documented in the spec
 */
export async function applyEdits(
  currentContent: string,
  edit: Edit,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  let next = currentContent
  let blocksApplied = 0

  if (edit.kind === 'search-replace') {
    if (edit.blocks.length === 0) {
      return { success: false, error: 'No edit blocks supplied.' }
    }
    for (let i = 0; i < edit.blocks.length; i++) {
      const block = edit.blocks[i]
      const result = findMatch(next, block.search, block.replace, block.startLine)
      if (!result.ok) {
        return {
          success: false,
          error: formatMatchFailure(i, edit.blocks.length, block.search, result.miss),
        }
      }
      next = next.slice(0, result.hit.start) + result.hit.rewrittenReplace + next.slice(result.hit.end)
      blocksApplied++
    }
  } else {
    next = edit.content
    blocksApplied = 1
  }

  if (opts.validate) {
    try {
      await opts.validate(next)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        success: false,
        error: formatValidationFailure(msg),
      }
    }
  }

  return { success: true, newContent: next, blocksApplied }
}

// ── Stable failure-feedback templates per plan 006 § "Failure feedback format" ──

function formatMatchFailure(
  blockIdx: number,
  totalBlocks: number,
  searchText: string,
  miss: MatchMiss,
): string {
  const firstSearchLine = firstLine(searchText)

  if (miss.ambiguousCandidates && miss.ambiguousCandidates.length >= 2) {
    const [a, b] = miss.ambiguousCandidates
    return [
      `Block ${blockIdx + 1} of ${totalBlocks} failed: SEARCH matched multiple candidates equally well.`,
      `Candidate A at line ${a.line + 1}: "${truncate(a.snippet, 80)}"`,
      `Candidate B at line ${b.line + 1}: "${truncate(b.snippet, 80)}"`,
      'Hint: add more surrounding context to disambiguate, or use the start_line parameter.',
    ].join('\n')
  }

  const confidence = miss.bestConfidence.toFixed(2)
  const lineNote =
    typeof miss.bestLine === 'number'
      ? ` was at line ${miss.bestLine + 1}:\n  ${truncate(miss.bestSnippet ?? '', 120)}`
      : ' (no close candidate found in the file)'
  return [
    `Block ${blockIdx + 1} of ${totalBlocks} failed: SEARCH did not match file content.`,
    `Best fuzzy candidate (confidence ${confidence}, threshold 0.95)${lineNote}`,
    `Your SEARCH was:`,
    `  ${truncate(firstSearchLine, 120)}`,
    'Hint: include 2-3 lines of unchanged context around the change so the match is unambiguous.',
  ].join('\n')
}

function formatValidationFailure(message: string): string {
  return [
    `Edit applied but result failed validation: ${message}`,
    'The file was NOT written. Adjust your edit to satisfy the validator.',
  ].join('\n')
}

function firstLine(s: string): string {
  const nl = s.indexOf('\n')
  return nl < 0 ? s : s.slice(0, nl)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}
