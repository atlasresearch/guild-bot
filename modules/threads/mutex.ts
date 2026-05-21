// Per-thread in-process async mutex. R1.8.
//
// Each thread ID maps to a tail-promise; new work chains onto it so writes for
// the same thread run strictly sequentially. Reads are not serialised.

import type { ThreadId } from './types'

const tails = new Map<ThreadId, Promise<unknown>>()

export function withThreadLock<T>(id: ThreadId, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(id) ?? Promise.resolve()
  // Each chained call swallows the prior error so one failing op does not
  // poison the queue — but the original caller still sees its own rejection.
  const next = prev.then(() => fn(), () => fn())
  tails.set(
    id,
    next.catch(() => {}),
  )
  return next
}

/** Test-only: clear all mutex state. */
export function _resetMutexForTests(): void {
  tails.clear()
}
