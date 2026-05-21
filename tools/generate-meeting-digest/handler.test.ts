import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// only mock @guildbot/llm (external boundary). Handler code runs for real.
const { mockStructured } = vi.hoisted(() => ({ mockStructured: vi.fn() }))
vi.mock('@guildbot/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/llm')>()
  return { ...actual, structured: mockStructured }
})

import handler from './handler'

const VALID_DIGEST = {
  insights: [{ summary: 'Team velocity improved', evidence: ['sprint review showed 20% increase'] }],
  actionItems: [{ task: 'Update docs', owner: 'Alice', due: '2026-02-01', status: 'pending', source: 'Alice volunteered' }],
  decisions: [{ decision: 'Switch to pnpm', rationale: 'Faster installs', source: 'discussed alternatives' }],
  openQuestions: [{ question: 'When to migrate CI?', owner: 'Bob', source: 'Bob raised the question' }],
}

describe('generate_meeting_digest handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns insights/actionItems/decisions/openQuestions on a valid digest', async () => {
    mockStructured.mockResolvedValueOnce({ success: true, data: VALID_DIGEST })
    const result = await handler({ transcript_lines: ['line 1', 'line 2'] }, {})
    expect(result.success).toBe(true)
    expect(result.data).toEqual(VALID_DIGEST)
  })

  it('returns success:false when structured() reports a schema failure', async () => {
    mockStructured.mockResolvedValueOnce({ success: false, error: 'bad shape' })
    const result = await handler({ transcript_lines: ['bad'] }, {})
    expect(result.success).toBe(false)
    expect((result.data as { error: string }).error).toBe('bad shape')
  })

  it('reads system prompt from system-prompt.md on every invocation', async () => {
    mockStructured.mockResolvedValueOnce({ success: true, data: VALID_DIGEST })
    await handler({ transcript_lines: ['test'] }, {})

    const systemPrompt = await readFile(join(import.meta.dirname, 'system-prompt.md'), 'utf-8')
    const callArgs = mockStructured.mock.calls[0][0]
    expect(callArgs.messages[0].role).toBe('system')
    expect(callArgs.messages[0].content).toBe(systemPrompt)
  })

  it('prepends user prompt to transcript when provided', async () => {
    mockStructured.mockResolvedValueOnce({ success: true, data: VALID_DIGEST })
    await handler(
      { transcript_lines: ['line 1', 'line 2'], prompt: 'Focus on action items' },
      {},
    )
    const userContent = mockStructured.mock.calls[0][0].messages[1].content
    expect(userContent).toContain('Focus on action items')
    expect(userContent).toContain('line 1')
    expect(userContent.indexOf('Focus on action items')).toBeLessThan(userContent.indexOf('line 1'))
  })

  it('joins transcript_lines with newlines', async () => {
    mockStructured.mockResolvedValueOnce({ success: true, data: VALID_DIGEST })
    await handler({ transcript_lines: ['alpha', 'beta', 'gamma'] }, {})
    expect(mockStructured.mock.calls[0][0].messages[1].content).toBe('alpha\nbeta\ngamma')
  })

  it('passes thinking:true to structured()', async () => {
    mockStructured.mockResolvedValueOnce({ success: true, data: VALID_DIGEST })
    await handler({ transcript_lines: ['x'] }, {})
    expect(mockStructured.mock.calls[0][0].thinking).toBe(true)
  })
})
