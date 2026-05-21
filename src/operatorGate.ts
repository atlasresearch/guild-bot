// Operator-gate helper (plan 007 R4.2). Pure logic so it can be unit-tested
// without spinning up Discord interaction mocks.

export type OperatorGateInput = {
  /** Role IDs the user holds (cache.keys() from the GuildMember). */
  memberRoleIds: readonly string[]
  /** True if the user has the Administrator permission. */
  isAdministrator: boolean
  /** config.memory.operatorRoleIds. */
  operatorRoleIds: readonly string[]
}

export type OperatorGateResult =
  | { ok: true }
  | { ok: false; reason: string }

export function evaluateOperatorGate(input: OperatorGateInput): OperatorGateResult {
  if (input.operatorRoleIds.length === 0) {
    if (input.isAdministrator) return { ok: true }
    return {
      ok: false,
      reason:
        'Only guild administrators may run this command (set config.memory.operatorRoleIds to delegate).',
    }
  }
  for (const rid of input.operatorRoleIds) {
    if (input.memberRoleIds.includes(rid)) return { ok: true }
  }
  return { ok: false, reason: 'You do not have an operator role for this guild.' }
}
