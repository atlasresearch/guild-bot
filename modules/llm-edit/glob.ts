// Minimal in-house glob matcher. Supports only:
//   - Exact path match: "prompt.md"
//   - Single-segment wildcards: "snippets/*.md"
// Explicitly NOT supported:
//   - Recursive globs (**)
//   - Character classes ([abc])
//   - Brace expansion ({a,b})
// Per plan 006 R5.3.

const UNSUPPORTED_TOKENS = [
  { token: '**', message: 'recursive globs (**) are not supported' },
  { token: '[', message: 'character classes ([...]) are not supported' },
  { token: '{', message: 'brace expansion ({...}) is not supported' },
] as const

/**
 * Throws if the pattern uses tokens we do not support, so the schema can
 * surface a clear error.
 */
export function assertSupportedGlob(pattern: string): void {
  for (const { token, message } of UNSUPPORTED_TOKENS) {
    if (pattern.includes(token)) {
      throw new Error(
        `unsupported glob "${pattern}": ${message}. Use multiple explicit entries instead.`,
      )
    }
  }
}

function globToRegex(pattern: string): RegExp {
  // Escape regex meta-chars except `*`, which we expand to "any character except /"
  const escaped = pattern.replace(/[.+^$()|\\?]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}

/**
 * Match `path` against `pattern`. Both are POSIX-style (forward slashes). Path
 * matching is case-sensitive (matches POSIX filesystem semantics; the bot's
 * guild dir lives on macOS/Linux where this is the convention).
 */
export function globMatch(pattern: string, path: string): boolean {
  assertSupportedGlob(pattern)
  return globToRegex(pattern).test(path)
}

/** Match `path` against any of `patterns`. */
export function globMatchAny(patterns: readonly string[], path: string): boolean {
  for (const p of patterns) {
    if (globMatch(p, path)) return true
  }
  return false
}
