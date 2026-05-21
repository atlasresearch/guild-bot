import { describe, expect, it } from 'vitest'
import { DIALECTS, DIALECT_NAMES, getDialect, type DialectName } from './dialects'
import type { LlmChatRequest } from './messages'

const baseReq = (overrides: Partial<LlmChatRequest> = {}): LlmChatRequest => ({
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
})

describe('DIALECTS registry', () => {
  it('exposes exactly five dialects with the expected names', () => {
    expect(DIALECT_NAMES.sort()).toEqual(
      ['generic', 'llama-server', 'ollama-v1', 'openai', 'vllm'].sort(),
    )
  })

  it('each dialect declares capabilities and a parallelToolCallsDefault', () => {
    for (const name of DIALECT_NAMES) {
      const d = DIALECTS[name]
      expect(typeof d.parallelToolCallsDefault).toBe('boolean')
      expect(d.capabilities).toHaveProperty('toolCalling')
      expect(d.capabilities).toHaveProperty('thinking')
      expect(d.capabilities).toHaveProperty('structuredJson')
      expect(d.capabilities).toHaveProperty('structuredJsonSchema')
    }
  })

  it('llama-server defaults parallelToolCalls to false; everything else defaults true', () => {
    expect(DIALECTS['llama-server'].parallelToolCallsDefault).toBe(false)
    for (const name of (['openai', 'ollama-v1', 'vllm', 'generic'] as DialectName[])) {
      expect(DIALECTS[name].parallelToolCallsDefault).toBe(true)
    }
  })
})

describe('getDialect', () => {
  it('returns the named dialect when valid', () => {
    expect(getDialect('vllm').name).toBe('vllm')
  })

  it('falls back to "generic" when name is undefined or unknown', () => {
    // Suppress console.warn from the fallback warning
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      expect(getDialect(undefined).name).toBe('generic')
      expect(getDialect('nope' as DialectName).name).toBe('generic')
    } finally {
      console.warn = originalWarn
    }
  })
})

describe('dialect.shapeRequest', () => {
  it('vllm forwards chat_template_kwargs.enable_thinking=false when thinking=false', () => {
    const { extraBody } = DIALECTS.vllm.shapeRequest(baseReq({ thinking: false }))
    expect(extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } })
  })

  it('vllm produces an empty extraBody when thinking is not specified', () => {
    expect(DIALECTS.vllm.shapeRequest(baseReq()).extraBody).toEqual({})
  })

  it('llama-server forwards chat_template_kwargs.enable_thinking=false when thinking=false', () => {
    const { extraBody } = DIALECTS['llama-server'].shapeRequest(baseReq({ thinking: false }))
    expect(extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } })
  })

  it('openai/ollama-v1/generic dialects add no extras for plain requests', () => {
    for (const name of (['openai', 'ollama-v1', 'generic'] as DialectName[])) {
      expect(DIALECTS[name].shapeRequest(baseReq()).extraBody).toEqual({})
    }
  })
})

describe('dialect.normaliseResponse', () => {
  // Minimum-viable raw response builder
  const raw = (overrides: Record<string, unknown> = {}): any => ({
    id: 'cmpl',
    object: 'chat.completion',
    created: 0,
    model: 'test',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'hello', refusal: null },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    ...overrides,
  })

  it('extracts content + usage + finishReason', () => {
    const out = DIALECTS.openai.normaliseResponse(raw())
    expect(out.content).toBe('hello')
    expect(out.usage).toEqual({ inputTokens: 1, outputTokens: 2 })
    expect(out.finishReason).toBe('stop')
    expect(out.dialect).toBe('openai')
  })

  it('vllm + llama-server extract message.reasoning_content into LlmChatResponse.reasoning', () => {
    const withReasoning = raw({
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'final answer', reasoning_content: 'why I said that' },
        },
      ],
    })
    expect(DIALECTS.vllm.normaliseResponse(withReasoning).reasoning).toBe('why I said that')
    expect(DIALECTS['llama-server'].normaliseResponse(withReasoning).reasoning).toBe('why I said that')
  })

  it('does NOT extract reasoning_content for openai/ollama-v1/generic dialects', () => {
    const withReasoning = raw({
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'final', reasoning_content: 'inner' },
        },
      ],
    })
    for (const name of (['openai', 'ollama-v1', 'generic'] as DialectName[])) {
      expect(DIALECTS[name].normaliseResponse(withReasoning).reasoning).toBeUndefined()
    }
  })

  it('normalises tool_calls (JSON-string arguments → object)', () => {
    const withToolCall = raw({
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
                function: { name: 'search_messages', arguments: '{"query":"hello"}' },
              },
            ],
          },
        },
      ],
    })
    const out = DIALECTS.openai.normaliseResponse(withToolCall)
    expect(out.toolCalls).toEqual([
      { id: 'call_1', name: 'search_messages', arguments: { query: 'hello' } },
    ])
    expect(out.finishReason).toBe('tool_calls')
  })

  it('tolerates non-JSON tool-call arguments by falling back to {}', () => {
    const withGarbageCall = raw({
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'noop', arguments: '<not json>' } },
            ],
          },
        },
      ],
    })
    expect(DIALECTS.openai.normaliseResponse(withGarbageCall).toolCalls[0].arguments).toEqual({})
  })
})
