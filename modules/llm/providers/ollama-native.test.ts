import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockChat, mockEmbeddings } = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockEmbeddings: vi.fn(),
}))

vi.mock('ollama', () => {
  class Ollama {
    constructor(_opts: unknown) {}
    chat = mockChat
    embeddings = mockEmbeddings
  }
  return { Ollama, default: { Ollama } }
})

import { _resetClientCacheForTests, chat, embed } from './ollama-native'

describe('ollama-native provider', () => {
  beforeEach(() => {
    _resetClientCacheForTests()
    mockChat.mockReset()
    mockEmbeddings.mockReset()
  })

  it('forwards a basic chat() request', async () => {
    mockChat.mockResolvedValue({
      model: 'qwen3.6',
      message: { role: 'assistant', content: 'hi' },
      prompt_eval_count: 1,
      eval_count: 2,
    })
    const out = await chat(
      { model: 'qwen3.6', messages: [{ role: 'user', content: 'hello' }] },
      { baseUrl: 'http://localhost:11434' },
    )
    expect(mockChat).toHaveBeenCalledOnce()
    const args = mockChat.mock.calls[0][0]
    expect(args.model).toBe('qwen3.6')
    expect(args.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(args.think).toBe(false)
    expect(out.content).toBe('hi')
    expect(out.dialect).toBe('ollama-native')
    expect(out.usage).toEqual({ inputTokens: 1, outputTokens: 2 })
  })

  it('passes think=true when thinking is requested', async () => {
    mockChat.mockResolvedValue({ message: { role: 'assistant', content: '' } })
    await chat(
      { model: 'qwen3.6', messages: [{ role: 'user', content: 'x' }], thinking: true },
      {},
    )
    expect(mockChat.mock.calls[0][0].think).toBe(true)
  })

  it('strips inline <think>...</think> blocks from content into reasoning', async () => {
    mockChat.mockResolvedValue({
      message: {
        role: 'assistant',
        content: '<think>let me reason</think>final answer',
      },
    })
    const out = await chat(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      {},
    )
    expect(out.content).toBe('final answer')
    expect(out.reasoning).toBe('let me reason')
  })

  it('prefers SDK thinking field over scraped <think> tags', async () => {
    mockChat.mockResolvedValue({
      message: {
        role: 'assistant',
        content: '<think>stale</think>final',
        thinking: 'real reasoning',
      },
    })
    const out = await chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, {})
    expect(out.reasoning).toBe('real reasoning')
  })

  it('maps response_format from { jsonSchema } to Ollama format field', async () => {
    mockChat.mockResolvedValue({ message: { role: 'assistant', content: '{}' } })
    await chat(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        responseFormat: {
          jsonSchema: { name: 'r', schema: { type: 'object', properties: {} } },
        },
      },
      {},
    )
    expect(mockChat.mock.calls[0][0].format).toEqual({ type: 'object', properties: {} })
  })

  it('normalises tool calls into LlmChatResponse.toolCalls', async () => {
    mockChat.mockResolvedValue({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'search', arguments: { q: 'hi' } } }],
      },
    })
    const out = await chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, {})
    expect(out.toolCalls).toEqual([{ id: 'call_0', name: 'search', arguments: { q: 'hi' } }])
    expect(out.finishReason).toBe('tool_calls')
  })

  it('embed() returns the embedding vector', async () => {
    mockEmbeddings.mockResolvedValue({ embedding: [0.1, 0.2] })
    const v = await embed('hi', 'nomic-embed-text', {})
    expect(mockEmbeddings).toHaveBeenCalledWith({ model: 'nomic-embed-text', prompt: 'hi' })
    expect(v).toEqual([0.1, 0.2])
  })

  it('embed() short-circuits on empty input', async () => {
    expect(await embed('', 'm', {})).toEqual([])
    expect(mockEmbeddings).not.toHaveBeenCalled()
  })
})
