import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoist the mock create() so we can assert on it inside tests
const { mockCreate, mockEmbed } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockEmbed: vi.fn(),
}))

vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: mockCreate } }
    embeddings = { create: mockEmbed }
    constructor(_opts: unknown) {}
  }
  return { OpenAI, default: OpenAI }
})

import { _resetClientCacheForTests, chat, embed } from './openai-compat'

const baseRaw = (overrides: Record<string, unknown> = {}) => ({
  id: 'cmpl',
  object: 'chat.completion',
  created: 0,
  model: 'qwen3.6',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  ...overrides,
})

describe('openai-compat provider', () => {
  beforeEach(() => {
    _resetClientCacheForTests()
    mockCreate.mockReset()
    mockEmbed.mockReset()
  })

  it('forwards a basic chat() request to the SDK', async () => {
    mockCreate.mockResolvedValue(baseRaw())
    const out = await chat(
      { model: 'qwen3.6', messages: [{ role: 'user', content: 'hello' }] },
      { baseUrl: 'http://localhost:11434/v1', dialect: 'ollama-v1' },
    )
    expect(mockCreate).toHaveBeenCalledOnce()
    const args = mockCreate.mock.calls[0][0]
    expect(args.model).toBe('qwen3.6')
    expect(args.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(out.content).toBe('hi')
    expect(out.dialect).toBe('ollama-v1')
  })

  it('R3.4: vllm dialect forwards extra_body.chat_template_kwargs when thinking=false', async () => {
    mockCreate.mockResolvedValue(baseRaw())
    await chat(
      { model: 'qwen3.6', messages: [{ role: 'user', content: 'x' }], thinking: false },
      { baseUrl: 'http://localhost:8000/v1', dialect: 'vllm' },
    )
    const args = mockCreate.mock.calls[0][0] as Record<string, unknown>
    expect(args.extra_body).toEqual({ chat_template_kwargs: { enable_thinking: false } })
  })

  it('R3.7: thinking=true against ollama-v1 throws UnsupportedCapabilityError', async () => {
    await expect(
      chat(
        { model: 'qwen3.6', messages: [{ role: 'user', content: 'x' }], thinking: true },
        { baseUrl: 'http://localhost:11434/v1', dialect: 'ollama-v1' },
      ),
    ).rejects.toThrow(/thinking/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('R2.4: thinking=false against ollama-v1 is a no-op (no throw)', async () => {
    mockCreate.mockResolvedValue(baseRaw())
    await expect(
      chat(
        { model: 'qwen3.6', messages: [{ role: 'user', content: 'x' }], thinking: false },
        { baseUrl: 'http://localhost:11434/v1', dialect: 'ollama-v1' },
      ),
    ).resolves.toBeTruthy()
  })

  it('R3.6: llama-server defaults parallel_tool_calls to false; vllm to true', async () => {
    mockCreate.mockResolvedValue(baseRaw())
    const tools = [
      { type: 'function' as const, function: { name: 'x', description: '', parameters: {} } },
    ]
    await chat(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], tools },
      { dialect: 'llama-server' },
    )
    expect((mockCreate.mock.calls[0][0] as { parallel_tool_calls?: boolean }).parallel_tool_calls).toBe(false)

    mockCreate.mockClear()
    await chat(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], tools },
      { dialect: 'vllm' },
    )
    expect((mockCreate.mock.calls[0][0] as { parallel_tool_calls?: boolean }).parallel_tool_calls).toBe(true)
  })

  it('R3.6: explicit parallelToolCalls=true overrides the llama-server default', async () => {
    mockCreate.mockResolvedValue(baseRaw())
    const tools = [
      { type: 'function' as const, function: { name: 'x', description: '', parameters: {} } },
    ]
    await chat(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools,
        parallelToolCalls: true,
      },
      { dialect: 'llama-server' },
    )
    expect((mockCreate.mock.calls[0][0] as { parallel_tool_calls?: boolean }).parallel_tool_calls).toBe(true)
  })

  it('R3.8: user-supplied extraBody overrides dialect-supplied entries', async () => {
    mockCreate.mockResolvedValue(baseRaw())
    await chat(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        thinking: false,
        extraBody: { chat_template_kwargs: { enable_thinking: 'custom' } },
      },
      { dialect: 'vllm' },
    )
    const args = mockCreate.mock.calls[0][0] as Record<string, unknown>
    expect(args.extra_body).toEqual({ chat_template_kwargs: { enable_thinking: 'custom' } })
  })

  it('builds response_format from responseFormat="json"', async () => {
    mockCreate.mockResolvedValue(baseRaw())
    await chat(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], responseFormat: 'json' },
      { dialect: 'openai' },
    )
    expect((mockCreate.mock.calls[0][0] as { response_format?: unknown }).response_format).toEqual({ type: 'json_object' })
  })

  it('builds response_format from responseFormat.jsonSchema', async () => {
    mockCreate.mockResolvedValue(baseRaw())
    await chat(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        responseFormat: { jsonSchema: { name: 'foo', schema: { type: 'object' } } },
      },
      { dialect: 'openai' },
    )
    const rf = (mockCreate.mock.calls[0][0] as { response_format?: Record<string, unknown> }).response_format
    expect(rf?.type).toBe('json_schema')
    expect(rf?.json_schema).toMatchObject({ name: 'foo', schema: { type: 'object' }, strict: true })
  })

  it('normalises tool calls from JSON-string arguments', async () => {
    mockCreate.mockResolvedValue(
      baseRaw({
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'search', arguments: '{"q":"hi"}' },
                },
              ],
            },
          },
        ],
      }),
    )
    const out = await chat(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { dialect: 'openai' },
    )
    expect(out.toolCalls).toEqual([{ id: 'call_1', name: 'search', arguments: { q: 'hi' } }])
    expect(out.finishReason).toBe('tool_calls')
  })

  it('embed() forwards to embeddings.create', async () => {
    mockEmbed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
    const v = await embed('hello', 'nomic-embed-text', { dialect: 'ollama-v1' })
    expect(mockEmbed).toHaveBeenCalledWith({ model: 'nomic-embed-text', input: 'hello' })
    expect(v).toEqual([0.1, 0.2, 0.3])
  })

  it('embed() short-circuits on empty input', async () => {
    expect(await embed('', 'm', { dialect: 'openai' })).toEqual([])
    expect(await embed('   ', 'm', { dialect: 'openai' })).toEqual([])
    expect(mockEmbed).not.toHaveBeenCalled()
  })
})
