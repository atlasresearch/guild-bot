# @guildbot/llm-edit

In-house matcher + path-safety primitives for LLM-driven file editing. Zero external dependencies.

The LLM-facing surface lives in the per-guild tools `tools/{read-file,edit-file,rewrite-file}/`. This module is the pure logic behind them.

## Public API

```ts
import { applyEdits, type Edit } from '@guildbot/llm-edit'

const result = await applyEdits(currentContent, {
  kind: 'search-replace',
  blocks: [{ search: '- Bob', replace: '- Bob (eng)' }],
})

if (result.success) {
  // result.newContent contains the edited string; write it with atomicWrite()
} else {
  // result.error is a stable-format human-readable string suitable for an LLM tool result
}
```

Whole-file mode for callers that already have a finished body:

```ts
await applyEdits(prev, { kind: 'whole-file', content: '...new body...' }, {
  validate: (s) => { if (!s.includes('# People')) throw new Error('missing required heading') },
})
```

Path-safety helper for tool handlers:

```ts
import { resolveAllowedPath } from '@guildbot/llm-edit'

const r = await resolveAllowedPath({
  filePath: args.file_path,
  guildDir: paths().root,
  allowlist: loadConfig().tools.editAllowlist,
})
if (!r.ok) return { success: false, data: { error: r.error } }
// r.absPath is realpath, under guildDir, not sensitive, matches allowlist
```

## Caller recommendations for local-model performance

When invoking the agent loop in contexts where these tools may be called by a local model (Qwen 3.x, Llama 3.x, etc.), follow these recommendations to maximise reliability:

1. **Pass `thinking: true` to `chat()`** when the model supports it. Qwen 3.x runs internal deliberation before producing the tool_call, which measurably improves format compliance and reduces retry rounds.
2. **Leave `max_tokens` ≥ 4096** for any chat call that may emit edit tool_calls. Long tool_call JSON arguments are the failure mode that costs most ([Qwen3 truncation issue](https://github.com/ollama/ollama/issues/14570)) — generous output headroom prevents silent truncation of the SEARCH/REPLACE blocks.
3. **Prefer many small blocks over few large blocks.** The `edit_file` tool description already steers the model toward this, but at the call-site level, validators that reject overly-large blocks can also help.
4. **Let the agent loop iterate.** Failure returns a stable-format feedback string in the tool result; the LLM reads it on the next iteration and self-corrects. Don't add a wrapper retry — `MAX_ITERATIONS = 5` in the agent loop is already the retry mechanism.

## Matcher cascade

For each search/replace block, in order:

1. **Exact match** (confidence 1.0) — `indexOf`; rejected if non-unique.
2. **Whitespace-insensitive match** (0.98) — collapses interior whitespace.
3. **Indentation-preserving match** (0.95) — strips leading indent; re-indents the replacement to match.
4. **Fuzzy match** (≥ 0.95 with ≥ 0.10 gap over second-best) — Levenshtein-ratio over line-aligned windows; honours `start_line` hint within ±10 lines.

Any failure produces a stable-format human-readable error string suitable for direct inclusion in a tool result. Templates: "Block N of M failed: SEARCH did not match…" / "Block N of M failed: SEARCH matched multiple candidates equally well…" / "Edit applied but result failed validation: …"

## Why no external dependencies

Aider, Cline, Roo-Code, Claude Code, and ChatGPT Canvas all converged on direct search/replace as frontier and mid-size models improved (see [Fast Apply Models are Already Dead](https://pashpashpash.substack.com/p/fast-apply-models-are-already-dead)). The algorithm is well-understood and small enough (~400 LOC including the matcher cascade and Levenshtein) that vendoring it avoids stale-dep risk (`diff-apply` last published mid-2025, single maintainer) and keeps the workspace zero-transitive-dep for this layer.
