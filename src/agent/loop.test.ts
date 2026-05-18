import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Only mock external API calls (ollama). Internal modules are exercised for real (R7.9).
const mockChat = vi.fn()
vi.mock('ollama', () => ({
  Ollama: vi.fn().mockImplementation(() => ({
    chat: mockChat,
  })),
}))

import { agentLoop, buildSystemPrompt } from './loop'

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

  it('should call ollama.chat with discovered tools and return final content', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: 'Hello from the model', tool_calls: null },
    })

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
  })

  it('should dispatch tool calls to real handlers and append role:tool results', async () => {
    // First call: model requests a tool call
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'echo-tool', arguments: { input: 'test' } } }],
      },
    })
    // Second call: model returns final answer
    mockChat.mockResolvedValueOnce({
      message: { content: 'Tool returned: test', tool_calls: null },
    })

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
    // Verify tool result was appended to messages
    const secondCallMessages = mockChat.mock.calls[1][0].messages
    const toolMsg = secondCallMessages.find((m: any) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    const parsed = JSON.parse(toolMsg.content)
    expect(parsed.success).toBe(true)
    expect(parsed.data.echoed).toBe('test')
  })

  it('should terminate after 5 iterations even if model keeps returning tool_calls', async () => {
    mockChat.mockResolvedValue({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'echo-tool', arguments: { input: 'loop' } } }],
      },
    })

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
    // Create a tool that throws
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

    // First call: model calls the bad tool
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'bad-tool', arguments: {} } }],
      },
    })
    // Second call: model returns final answer
    mockChat.mockResolvedValueOnce({
      message: { content: 'Recovered', tool_calls: null },
    })

    const result = await agentLoop({
      userMessage: 'Call bad tool',
      conversationHistory: [],
      context: {},
      model: 'test-model',
      toolsDir: fixtureToolsDir,
      skillsDir: fixtureSkillsDir,
    })

    expect(result).toBe('Recovered')
    // Verify error was appended as tool result
    const secondCallMessages = mockChat.mock.calls[1][0].messages
    const toolMsg = secondCallMessages.find((m: any) => m.role === 'tool')
    const parsed = JSON.parse(toolMsg.content)
    expect(parsed.success).toBe(false)
    expect(parsed.data.error).toContain('handler broke')
  })

  it('should build system prompt from discovered skill descriptions', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: 'OK', tool_calls: null },
    })

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

  it('should call onProgress with status updates during the loop', async () => {
    // First call: model requests a tool call
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'echo-tool', arguments: { input: 'hi' } } }],
      },
    })
    // Second call: model returns final answer
    mockChat.mockResolvedValueOnce({
      message: { content: 'Done', tool_calls: null },
    })

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

    // Should have: Thinking (iter 0), Using tool, Thinking (iter 1)
    expect(onProgress).toHaveBeenCalledWith('Thinking...')
    expect(onProgress).toHaveBeenCalledWith('Using echo tool...')
    expect(onProgress.mock.calls.length).toBe(3)
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
