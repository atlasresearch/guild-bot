// @guildbot/llm-edit — pure file-edit primitives.
//
// Per plan 006:
//   - Module exports `applyEdits` + types only. No LLM-interaction helpers,
//     no system-prompt fragments. The LLM-facing surface lives in the
//     per-guild tools (tools/{read-file,edit-file,rewrite-file}).
//   - In-house matcher cascade (exact → whitespace-insensitive →
//     indentation-preserving → fuzzy Levenshtein) tuned for local models
//     like Qwen 3.6.
//   - No external diff/patch/glob libraries.

export { applyEdits } from './applyEdits'
export type {
  Edit,
  SearchReplaceBlock,
  ApplyOptions,
  ApplyResult,
} from './types'
export { globMatch, globMatchAny, assertSupportedGlob } from './glob'
export { resolveAllowedPath, type ResolveOutcome, type ResolveOptions } from './resolvePath'
