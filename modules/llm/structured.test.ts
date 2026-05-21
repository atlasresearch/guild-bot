import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// Mock the OpenAI SDK because structured() routes through openai-compat
// when the test fixture's provider is "ollama" with no dialect set... actually
// structured() routes via the active config. Our pool fixture is provider=ollama
// so structured() goes through ollama-native. Mock that too.

const { mockOpenAICreate, mockOllamaChat } = vi.hoisted(() => ({
  mockOpenAICreate: vi.fn(),
  mockOllamaChat: vi.fn(),
}))

vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: mockOpenAICreate } }
    embeddings = { create: vi.fn() }
    constructor(_opts: unknown) {}
  }
  return { OpenAI, default: OpenAI }
})

vi.mock('ollama', () => {
  class Ollama {
    chat = mockOllamaChat
    embeddings = vi.fn()
    constructor(_opts: unknown) {}
  }
  return { Ollama, default: { Ollama } }
})

import { _resetClientCachesForTests, structured } from './index'

const Schema = z.object({
  decision: z.string(),
  rationale: z.string().optional(),
})

describe('structured()', () => {
  beforeEach(() => {
    _resetClientCachesForTests()
    mockOpenAICreate.mockReset()
    mockOllamaChat.mockReset()
  })

  it('jsonSchema path: routes through ollama-native (Ollama 0.5+ supports json_schema)', async () => {
    mockOllamaChat.mockResolvedValue({
      message: {
        role: 'assistant',
        content: JSON.stringify({ decision: 'ship', rationale: 'tests pass' }),
      },
    })
    const result = await structured({ schema: Schema, messages: [{ role: 'user', content: 'ship?' }] })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ decision: 'ship', rationale: 'tests pass' })
    }
    // Ollama-native received the schema as the `format` field
    const args = mockOllamaChat.mock.calls[0][0]
    expect(args.format).toBeTypeOf('object')
    expect(args.format).toHaveProperty('properties')
  })

  it('json + parse fallback path: returns failure when schema validation fails', async () => {
    mockOllamaChat.mockResolvedValue({
      message: { role: 'assistant', content: JSON.stringify({ wrong: 'shape' }) },
    })
    const result = await structured({ schema: Schema, messages: [{ role: 'user', content: 'x' }] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toMatch(/decision/)
    }
  })

  it('returns failure when LLM emits invalid JSON', async () => {
    mockOllamaChat.mockResolvedValue({
      message: { role: 'assistant', content: 'this is not json' },
    })
    const result = await structured({ schema: Schema, messages: [{ role: 'user', content: 'x' }] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toMatch(/valid JSON/)
    }
  })

  it('surfaces the underlying cause chain when the provider call throws', async () => {
    // Reproduces the user-visible "Failed to generate meeting digest: fetch
    // failed" — undici wraps the real reason (ECONNREFUSED, UND_ERR_*, …) in
    // err.cause, which used to be lost. structured() must walk the chain and
    // include provider + baseUrl so the operator can debug.
    const inner: any = new Error('connect ECONNREFUSED 127.0.0.1:11434')
    inner.code = 'ECONNREFUSED'
    const outer: any = new Error('fetch failed')
    outer.cause = inner
    mockOllamaChat.mockRejectedValue(outer)

    const result = await structured({ schema: Schema, messages: [{ role: 'user', content: 'x' }] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toMatch(/fetch failed/)
      expect(result.error).toMatch(/ECONNREFUSED/)
      expect(result.error).toMatch(/caused by/)
      expect(result.error).toMatch(/provider=ollama/)
    }
  })

  it('forwards thinking option to the underlying chat()', async () => {
    mockOllamaChat.mockResolvedValue({
      message: { role: 'assistant', content: '{"decision":"x"}' },
    })
    await structured({
      schema: Schema,
      messages: [{ role: 'user', content: 'x' }],
      thinking: true,
    })
    expect(mockOllamaChat.mock.calls[0][0].think).toBe(true)
  })
})
