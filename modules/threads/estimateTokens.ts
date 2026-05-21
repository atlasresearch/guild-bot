// Token estimator. Dependency-free, single call-site for the compaction
// threshold so a future tokenizer swap is one file. `Math.ceil(chars / 4)` is
// slightly conservative — good enough until proven inadequate.

import type { ThreadMessage } from './types'

export function estimateTokens(messages: Pick<ThreadMessage, 'content'>[]): number {
  let chars = 0
  for (const m of messages) chars += m.content?.length ?? 0
  return Math.ceil(chars / 4)
}
