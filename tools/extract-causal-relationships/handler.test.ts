import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// R7.9: only mock ollama (external API). Handler code runs for real.
const mockChat = vi.fn()
vi.mock('ollama', () => ({
  Ollama: vi.fn().mockImplementation(() => ({
    chat: mockChat,
  })),
}))

import handler, { CldOutputSchema } from './handler'

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

  it('should return nodes and relationships from valid LLM response', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: JSON.stringify(VALID_CLD) },
    })

    const result = await handler({ text: 'Some causal text' }, {})
    expect(result.success).toBe(true)
    expect(result.data).toEqual(VALID_CLD)
  })

  it('should return success:false when LLM response fails schema validation', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: JSON.stringify({ nodes: 'not-an-array' }) },
    })

    const result = await handler({ text: 'Bad text' }, {})
    expect(result.success).toBe(false)
    expect((result.data as any).error).toBeDefined()
  })

  it('should read system prompt from system-prompt.md on every invocation', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: JSON.stringify(VALID_CLD) },
    })

    await handler({ text: 'Test' }, {})

    const systemPrompt = await readFile(join(import.meta.dirname, 'system-prompt.md'), 'utf-8')
    const callArgs = mockChat.mock.calls[0][0]
    expect(callArgs.messages[0].role).toBe('system')
    expect(callArgs.messages[0].content).toBe(systemPrompt)
  })

  it('should prepend user prompt to text when provided', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: JSON.stringify(VALID_CLD) },
    })

    await handler({ text: 'Source text here', prompt: 'Focus on economics' }, {})

    const callArgs = mockChat.mock.calls[0][0]
    const userContent = callArgs.messages[1].content
    expect(userContent).toContain('Focus on economics')
    expect(userContent).toContain('Source text here')
    expect(userContent.indexOf('Focus on economics')).toBeLessThan(userContent.indexOf('Source text here'))
  })
})
