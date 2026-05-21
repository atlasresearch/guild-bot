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

const VALID_CLD = {
  nodes: [
    { label: 'Investment', type: 'driver' },
    { label: 'Revenue', type: 'driver' },
  ],
  relationships: [
    {
      subject: 'Investment',
      object: 'Revenue',
      predicate: 'positive',
      reasoning: 'More investment leads to more revenue',
      relevant: ['we invested more and revenue grew'],
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
}

describe('extract_causal_relationships handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns nodes and relationships on a valid CLD response', async () => {
    mockStructured.mockResolvedValueOnce({ success: true, data: VALID_CLD })
    const result = await handler({ text: 'Some causal text' }, {})
    expect(result.success).toBe(true)
    expect(result.data).toEqual(VALID_CLD)
  })

  it('returns success:false when structured() reports a schema failure', async () => {
    mockStructured.mockResolvedValueOnce({ success: false, error: 'bad shape' })
    const result = await handler({ text: 'Bad text' }, {})
    expect(result.success).toBe(false)
    expect((result.data as { error: string }).error).toBe('bad shape')
  })

  it('reads system prompt from system-prompt.md on every invocation', async () => {
    mockStructured.mockResolvedValueOnce({ success: true, data: VALID_CLD })
    await handler({ text: 'Test' }, {})
    const systemPrompt = await readFile(join(import.meta.dirname, 'system-prompt.md'), 'utf-8')
    const callArgs = mockStructured.mock.calls[0][0]
    expect(callArgs.messages[0].role).toBe('system')
    expect(callArgs.messages[0].content).toBe(systemPrompt)
  })

  it('prepends user prompt to text when provided', async () => {
    mockStructured.mockResolvedValueOnce({ success: true, data: VALID_CLD })
    await handler({ text: 'Source text here', prompt: 'Focus on economics' }, {})
    const userContent = mockStructured.mock.calls[0][0].messages[1].content
    expect(userContent).toContain('Focus on economics')
    expect(userContent).toContain('Source text here')
    expect(userContent.indexOf('Focus on economics')).toBeLessThan(userContent.indexOf('Source text here'))
  })

  it('passes thinking:true to structured()', async () => {
    mockStructured.mockResolvedValueOnce({ success: true, data: VALID_CLD })
    await handler({ text: 'x' }, {})
    expect(mockStructured.mock.calls[0][0].thinking).toBe(true)
  })
})
