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

import handler, { MeetingDigestSchema } from './handler'

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

  it('should return insights, actionItems, decisions, openQuestions from valid LLM response', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: JSON.stringify(VALID_DIGEST) },
    })

    const result = await handler({ transcript_lines: ['line 1', 'line 2'] }, {})
    expect(result.success).toBe(true)
    expect(result.data).toEqual(VALID_DIGEST)
  })

  it('should return success:false when LLM response fails schema validation', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: JSON.stringify({ insights: 'not-an-array' }) },
    })

    const result = await handler({ transcript_lines: ['bad'] }, {})
    expect(result.success).toBe(false)
    expect((result.data as any).error).toBeDefined()
  })

  it('should read system prompt from system-prompt.md on every invocation', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: JSON.stringify(VALID_DIGEST) },
    })

    await handler({ transcript_lines: ['test'] }, {})

    const systemPrompt = await readFile(join(import.meta.dirname, 'system-prompt.md'), 'utf-8')
    const callArgs = mockChat.mock.calls[0][0]
    expect(callArgs.messages[0].role).toBe('system')
    expect(callArgs.messages[0].content).toBe(systemPrompt)
  })

  it('should prepend user prompt to transcript when provided', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: JSON.stringify(VALID_DIGEST) },
    })

    await handler({ transcript_lines: ['line 1', 'line 2'], prompt: 'Focus on action items' }, {})

    const callArgs = mockChat.mock.calls[0][0]
    const userContent = callArgs.messages[1].content
    expect(userContent).toContain('Focus on action items')
    expect(userContent).toContain('line 1')
    expect(userContent.indexOf('Focus on action items')).toBeLessThan(userContent.indexOf('line 1'))
  })

  it('should join transcript_lines with newlines for the LLM message', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: JSON.stringify(VALID_DIGEST) },
    })

    await handler({ transcript_lines: ['alpha', 'beta', 'gamma'] }, {})

    const callArgs = mockChat.mock.calls[0][0]
    const userContent = callArgs.messages[1].content
    expect(userContent).toBe('alpha\nbeta\ngamma')
  })
})
