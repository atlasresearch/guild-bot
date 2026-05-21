export type SearchReplaceBlock = {
  /** Exact text expected in the file. Multi-line. */
  search: string
  /** Replacement text. Empty string deletes. */
  replace: string
  /** Optional line hint (1-based) to disambiguate when search may match more than once. */
  startLine?: number
}

export type Edit =
  | { kind: 'search-replace'; blocks: SearchReplaceBlock[] }
  | { kind: 'whole-file'; content: string }

export type ApplyOptions = {
  /**
   * Optional validator run on the post-edit content before commit. Throws to reject.
   * Common use: non-empty body, byte cap, secret-pattern denylist, Zod schema.
   */
  validate?: (newContent: string) => void | Promise<void>
}

export type ApplyResult =
  | { success: true; newContent: string; blocksApplied: number }
  | {
      success: false
      /**
       * Human-readable failure message suitable for direct inclusion in a tool
       * result. Format is stable so the LLM can pattern-match.
       */
      error: string
    }
