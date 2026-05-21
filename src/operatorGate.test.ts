// R6.5: operator role gate for slash commands.
//   - members listed in config.memory.operatorRoleIds are allowed
//   - empty role list → admin-only default

import { describe, expect, it } from 'vitest'
import { evaluateOperatorGate } from './operatorGate'

describe('evaluateOperatorGate', () => {
  it('allows admins when operatorRoleIds is empty', () => {
    const r = evaluateOperatorGate({
      memberRoleIds: [],
      isAdministrator: true,
      operatorRoleIds: [],
    })
    expect(r.ok).toBe(true)
  })

  it('blocks non-admins when operatorRoleIds is empty', () => {
    const r = evaluateOperatorGate({
      memberRoleIds: ['ROLE_A'],
      isAdministrator: false,
      operatorRoleIds: [],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/administrators/i)
  })

  it('allows members whose role appears in operatorRoleIds', () => {
    const r = evaluateOperatorGate({
      memberRoleIds: ['ROLE_OPERATOR', 'ROLE_GENERIC'],
      isAdministrator: false,
      operatorRoleIds: ['ROLE_OPERATOR'],
    })
    expect(r.ok).toBe(true)
  })

  it('blocks members whose role does NOT appear in operatorRoleIds (even admins)', () => {
    // Per the spec: when operatorRoleIds is non-empty, admin-only fallback no
    // longer applies. Operators delegated to specific roles get exclusive control.
    const r = evaluateOperatorGate({
      memberRoleIds: ['ROLE_RANDOM'],
      isAdministrator: true,
      operatorRoleIds: ['ROLE_OPERATOR'],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/operator role/)
  })
})
