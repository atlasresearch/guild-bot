import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Only mock the @guildbot/llm public API; internal modules are exercised for real (R7.7).
const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }))
vi.mock('@guildbot/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/llm')>()
  return {
    ...actual,
    chat: mockChat,
  }
})

import { agentLoop, buildSystemPrompt } from './loop'

const noToolsResponse = (content: string) => ({
  content,
  toolCalls: [],
  model: 'test-model',
  finishReason: 'stop' as const,
  dialect: 'ollama-native',
})

const toolCallResponse = (calls: Array<{ name: string; arguments: Record<string, unknown> }>) => ({
  content: '',
  toolCalls: calls.map((c, i) => ({ id: `call_${i}`, ...c })),
  model: 'test-model',
  finishReason: 'tool_calls' as const,
  dialect: 'ollama-native',
})

describe('agentLoop', () => {
  let fixtureToolsDir: string
  let fixtureSkillsDir: string

  beforeEach(async () => {
    fixtureToolsDir = await mkdtemp(join(tmpdir(), 'agent-loop-tools-'))
    fixtureSkillsDir = await mkdtemp(join(tmpdir(), 'agent-loop-skills-'))

    await mkdir(join(fixtureToolsDir, 'echo-tool'))
    await writeFile(
      join(fixtureToolsDir, 'echo-tool', 'definition.json'),
      JSON.stringify({
        type: 'function',
        function: {
          name: 'echo_tool',
          description: 'Echoes input back',
          parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
        },
      })
    )
    await writeFile(
      join(fixtureToolsDir, 'echo-tool', 'handler.mjs'),
      `export default async (args) => ({ success: true, data: { echoed: args.input } })`
    )

    await mkdir(join(fixtureSkillsDir, 'test-skill'))
    await writeFile(
      join(fixtureSkillsDir, 'test-skill', 'SKILL.md'),
      `---\nname: test-skill\ndescription: 'A test skill'\n---\n# Test`
    )
  })

  afterEach(async () => {
    await rm(fixtureToolsDir, { recursive: true, force: true })
    await rm(fixtureSkillsDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('should call chat() with discovered tools and return final content', async () => {
    mockChat.mockResolvedValueOnce(noToolsResponse('Hello from the model'))

    const result = await agentLoop({
      userMessage: 'Hi',
      conversationHistory: [],
      context: {},
      model: 'test-model',
      toolsDir: fixtureToolsDir,
      skillsDir: fixtureSkillsDir,
    })

    expect(result).toBe('Hello from the model')
    expect(mockChat).toHaveBeenCalledOnce()
    const callArgs = mockChat.mock.calls[0][0]
    expect(callArgs.tools).toHaveLength(1)
    expect(callArgs.tools[0].function.name).toBe('echo_tool')
    expect(callArgs.thinking).toBe(false)
  })

  it('should dispatch tool calls to real handlers and append role:tool results', async () => {
    mockChat.mockResolvedValueOnce(toolCallResponse([{ name: 'echo-tool', arguments: { input: 'test' } }]))
    mockChat.mockResolvedValueOnce(noToolsResponse('Tool returned: test'))

    const result = await agentLoop({
      userMessage: 'Echo test',
      conversationHistory: [],
      context: {},
      model: 'test-model',
      toolsDir: fixtureToolsDir,
      skillsDir: fixtureSkillsDir,
    })

    expect(result).toBe('Tool returned: test')
    expect(mockChat).toHaveBeenCalledTimes(2)
    const secondCallMessages = mockChat.mock.calls[1][0].messages
    const toolMsg = secondCallMessages.find((m: { role: string }) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    const parsed = JSON.parse(toolMsg.content)
    expect(parsed.success).toBe(true)
    expect(parsed.data.echoed).toBe('test')
  })

  it('should terminate after 5 iterations even if model keeps returning tool_calls', async () => {
    mockChat.mockResolvedValue(toolCallResponse([{ name: 'echo-tool', arguments: { input: 'loop' } }]))

    const result = await agentLoop({
      userMessage: 'Loop forever',
      conversationHistory: [],
      context: {},
      model: 'test-model',
      toolsDir: fixtureToolsDir,
      skillsDir: fixtureSkillsDir,
    })

    expect(mockChat).toHaveBeenCalledTimes(5)
    expect(typeof result).toBe('string')
  })

  it('should handle tool handler errors gracefully and continue the loop', async () => {
    await mkdir(join(fixtureToolsDir, 'bad-tool'))
    await writeFile(
      join(fixtureToolsDir, 'bad-tool', 'definition.json'),
      JSON.stringify({
        type: 'function',
        function: { name: 'bad_tool', description: 'Throws', parameters: { type: 'object', properties: {} } },
      })
    )
    await writeFile(
      join(fixtureToolsDir, 'bad-tool', 'handler.mjs'),
      `export default async () => { throw new Error('handler broke') }`
    )

    mockChat.mockResolvedValueOnce(toolCallResponse([{ name: 'bad-tool', arguments: {} }]))
    mockChat.mockResolvedValueOnce(noToolsResponse('Recovered'))

    const result = await agentLoop({
      userMessage: 'Call bad tool',
      conversationHistory: [],
      context: {},
      model: 'test-model',
      toolsDir: fixtureToolsDir,
      skillsDir: fixtureSkillsDir,
    })

    expect(result).toBe('Recovered')
    const secondCallMessages = mockChat.mock.calls[1][0].messages
    const toolMsg = secondCallMessages.find((m: { role: string }) => m.role === 'tool')
    const parsed = JSON.parse(toolMsg.content)
    expect(parsed.success).toBe(false)
    expect(parsed.data.error).toContain('handler broke')
  })

  it('should build system prompt from discovered skill descriptions', async () => {
    mockChat.mockResolvedValueOnce(noToolsResponse('OK'))

    await agentLoop({
      userMessage: 'Hi',
      conversationHistory: [],
      context: {},
      model: 'test-model',
      toolsDir: fixtureToolsDir,
      skillsDir: fixtureSkillsDir,
    })

    const systemMsg = mockChat.mock.calls[0][0].messages[0]
    expect(systemMsg.role).toBe('system')
    expect(systemMsg.content).toContain('test-skill')
    expect(systemMsg.content).toContain('A test skill')
  })

  it('R3.2: should call onMessage for assistant + tool result + final assistant turns', async () => {
    mockChat.mockResolvedValueOnce(toolCallResponse([{ name: 'echo-tool', arguments: { input: 'hi' } }]))
    mockChat.mockResolvedValueOnce(noToolsResponse('All done'))

    const messages: Array<{ role: string; content: string; toolCallId?: string }> = []
    const onMessage = vi.fn(async (m: { role: string; content: string; toolCallId?: string }) => {
      messages.push({ role: m.role, content: m.content, toolCallId: m.toolCallId })
    })

    const result = await agentLoop({
      userMessage: 'Hi',
      conversationHistory: [],
      context: {},
      model: 'test-model',
      toolsDir: fixtureToolsDir,
      skillsDir: fixtureSkillsDir,
      onMessage,
    })

    expect(result).toBe('All done')
    // 1) assistant turn with tool_calls
    // 2) tool result
    // 3) final assistant turn
    expect(messages).toHaveLength(3)
    expect(messages[0].role).toBe('assistant')
    expect(messages[1].role).toBe('tool')
    expect(messages[1].toolCallId).toBe('call_0')
    expect(messages[2].role).toBe('assistant')
    expect(messages[2].content).toBe('All done')
  })

  it('R3.4: onMessage errors abort the loop and propagate', async () => {
    mockChat.mockResolvedValueOnce(noToolsResponse('Hello'))
    const onMessage = vi.fn().mockRejectedValue(new Error('disk full'))

    await expect(
      agentLoop({
        userMessage: 'Hi',
        conversationHistory: [],
        context: {},
        model: 'test-model',
        toolsDir: fixtureToolsDir,
        skillsDir: fixtureSkillsDir,
        onMessage,
      }),
    ).rejects.toThrow('disk full')
  })

  it('R3.1: accepts conversation history containing assistant + tool messages and forwards their core fields to chat()', async () => {
    mockChat.mockResolvedValueOnce(noToolsResponse('OK'))
    await agentLoop({
      userMessage: 'continue',
      conversationHistory: [
        { role: 'user', content: 'prior question' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'echo_tool', arguments: { input: 'x' } }],
        },
        {
          role: 'tool',
          content: '{"ok":true}',
          toolCallId: 'tc1',
          toolName: 'echo_tool',
        },
      ],
      context: {},
      model: 'test-model',
      toolsDir: fixtureToolsDir,
      skillsDir: fixtureSkillsDir,
    })
    const sent = mockChat.mock.calls[0][0].messages as Array<{ role: string; toolCallId?: string; toolCalls?: unknown }>
    // system + 3 historical + final user
    expect(sent.length).toBe(5)
    const tool = sent.find((m) => m.role === 'tool')
    expect(tool?.toolCallId).toBe('tc1')
    const asst = sent.find((m) => m.role === 'assistant')
    expect(asst?.toolCalls).toBeDefined()
  })

  it('should call onProgress with status updates during the loop', async () => {
    mockChat.mockResolvedValueOnce(toolCallResponse([{ name: 'echo-tool', arguments: { input: 'hi' } }]))
    mockChat.mockResolvedValueOnce(noToolsResponse('Done'))

    const onProgress = vi.fn()

    await agentLoop({
      userMessage: 'Test progress',
      conversationHistory: [],
      context: {},
      model: 'test-model',
      toolsDir: fixtureToolsDir,
      skillsDir: fixtureSkillsDir,
      onProgress,
    })

    expect(onProgress).toHaveBeenCalledWith('Thinking...')
    expect(onProgress).toHaveBeenCalledWith('Using echo tool...')
    expect(onProgress.mock.calls.length).toBe(3)
  })
})

describe('R3.3: agent loop platform independence', () => {
  it('does not import @guildbot/threads or @guildbot/discord-index', async () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const content = fs.readFileSync(path.join(__dirname, 'loop.ts'), 'utf8')
    const importPattern = /(?:from\s+['"]|require\(\s*['"])([^'"\)]+)['"]/g
    const imports = [...content.matchAll(importPattern)].map((m) => m[1])
    expect(imports).not.toContain('@guildbot/threads')
    expect(imports).not.toContain('@guildbot/discord-index')
    expect(imports).not.toContain('discord.js')
  })
})

describe('buildSystemPrompt', () => {
  it('should include skill descriptions in the prompt', () => {
    const prompt = buildSystemPrompt([
      { name: 'search', description: 'Search messages' },
      { name: 'diagram', description: 'Generate diagrams' },
    ])
    expect(prompt).toContain('**search**')
    expect(prompt).toContain('Search messages')
    expect(prompt).toContain('**diagram**')
    expect(prompt).toContain('Generate diagrams')
  })

  it('should produce a valid prompt with empty skill list', () => {
    const prompt = buildSystemPrompt([])
    expect(prompt).toContain('Guild Bot')
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })
})
