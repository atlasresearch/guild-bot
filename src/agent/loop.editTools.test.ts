// R6.10: happy-path round trip through the real agent loop with mocked chat().
// Verifies that the three new edit tools register, dispatch, and self-correct
// via the standard tool-result feedback path.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockChat, TEST_GUILD_DIR, currentAllowlist } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-edit-tools-'))
  return {
    mockChat: vi.fn(),
    TEST_GUILD_DIR: dir as string,
    currentAllowlist: { value: [] as string[] },
  }
})

vi.mock('@guildbot/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/llm')>()
  return { ...actual, chat: mockChat }
})

vi.mock('@guildbot/guild-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/guild-config')>()
  return {
    ...actual,
    paths: () => actual.paths(TEST_GUILD_DIR),
    loadConfig: () => ({
      tools: { disabled: [], editAllowlist: currentAllowlist.value },
      llm: { models: { default: 'qwen3.6' } },
    }) as any,
  }
})

import { agentLoop } from './loop'

const REPO_TOOLS_DIR = join(__dirname, '..', '..', 'tools')
const REPO_SKILLS_DIR = join(__dirname, '..', '..', 'skills')

const noToolCalls = (content: string) => ({
  content,
  toolCalls: [],
  model: 'qwen3.6',
  finishReason: 'stop' as const,
  dialect: 'ollama-native',
})

const callTool = (name: string, args: Record<string, unknown>) => ({
  content: '',
  toolCalls: [{ id: 'call_0', name, arguments: args }],
  model: 'qwen3.6',
  finishReason: 'tool_calls' as const,
  dialect: 'ollama-native',
})

describe('agent loop + edit tools', () => {
  beforeEach(() => {
    rmSync(TEST_GUILD_DIR, { recursive: true, force: true })
    mkdirSync(TEST_GUILD_DIR, { recursive: true })
    writeFileSync(
      join(TEST_GUILD_DIR, 'memory.md'),
      '# People\n- Alice\n- Bob\n\n# Decisions\n- ship v1\n',
    )
    currentAllowlist.value = ['memory.md', 'prompt.md']
    mockChat.mockReset()
  })

  afterEach(() => {
    rmSync(TEST_GUILD_DIR, { recursive: true, force: true })
    currentAllowlist.value = []
  })

  it('LLM calls read_file then edit_file; result is written atomically', async () => {
    mockChat.mockResolvedValueOnce(callTool('read_file', { file_path: 'memory.md' }))
    mockChat.mockResolvedValueOnce(
      callTool('edit_file', {
        file_path: 'memory.md',
        blocks: [{ search: '- Bob', replace: '- Bob (eng)' }],
      }),
    )
    mockChat.mockResolvedValueOnce(noToolsResponseFinal('Updated.'))

    const result = await agentLoop({
      userMessage: 'Update memory.md to add (eng) after Bob',
      conversationHistory: [],
      context: {},
      model: 'qwen3.6',
      toolsDir: REPO_TOOLS_DIR,
      skillsDir: REPO_SKILLS_DIR,
    })

    expect(result).toBe('Updated.')
    expect(readFileSync(join(TEST_GUILD_DIR, 'memory.md'), 'utf8')).toContain('- Bob (eng)')
  })

  it('Self-corrects through the tool-result feedback when first edit misses', async () => {
    // First attempt: bad SEARCH — handler returns structured feedback.
    mockChat.mockResolvedValueOnce(
      callTool('edit_file', {
        file_path: 'memory.md',
        blocks: [{ search: 'completely wrong text that is nowhere', replace: 'x' }],
      }),
    )
    // Second attempt: correct SEARCH after reading the feedback.
    mockChat.mockResolvedValueOnce(
      callTool('edit_file', {
        file_path: 'memory.md',
        blocks: [{ search: '- ship v1', replace: '- ship v2' }],
      }),
    )
    mockChat.mockResolvedValueOnce(noToolsResponseFinal('Done.'))

    const result = await agentLoop({
      userMessage: 'Change ship v1 to ship v2',
      conversationHistory: [],
      context: {},
      model: 'qwen3.6',
      toolsDir: REPO_TOOLS_DIR,
      skillsDir: REPO_SKILLS_DIR,
    })

    expect(result).toBe('Done.')
    // The second iteration must have included the failure feedback as a tool message
    const secondCallMessages = mockChat.mock.calls[1][0].messages as Array<{ role: string; content: string }>
    const toolFailure = secondCallMessages.find((m) => m.role === 'tool')
    expect(toolFailure?.content).toMatch(/SEARCH did not match/)
    expect(toolFailure?.content).toMatch(/Hint: include 2-3 lines/)
    // And the file was eventually written
    expect(readFileSync(join(TEST_GUILD_DIR, 'memory.md'), 'utf8')).toContain('- ship v2')
  })

  it('rewrite_file via tool call replaces the file atomically', async () => {
    mockChat.mockResolvedValueOnce(
      callTool('rewrite_file', { file_path: 'memory.md', content: 'COMPLETELY NEW BODY\n' }),
    )
    mockChat.mockResolvedValueOnce(noToolsResponseFinal('OK.'))

    const result = await agentLoop({
      userMessage: 'Replace memory.md',
      conversationHistory: [],
      context: {},
      model: 'qwen3.6',
      toolsDir: REPO_TOOLS_DIR,
      skillsDir: REPO_SKILLS_DIR,
    })

    expect(result).toBe('OK.')
    expect(readFileSync(join(TEST_GUILD_DIR, 'memory.md'), 'utf8')).toBe('COMPLETELY NEW BODY\n')
  })

  it('Allowlist-deny surfaces to the LLM as a tool-result error mentioning config.tools.editAllowlist', async () => {
    currentAllowlist.value = [] // deny-all
    mockChat.mockResolvedValueOnce(
      callTool('edit_file', {
        file_path: 'memory.md',
        blocks: [{ search: 'x', replace: 'y' }],
      }),
    )
    mockChat.mockResolvedValueOnce(noToolsResponseFinal('I cannot edit that file.'))

    await agentLoop({
      userMessage: 'try to edit',
      conversationHistory: [],
      context: {},
      model: 'qwen3.6',
      toolsDir: REPO_TOOLS_DIR,
      skillsDir: REPO_SKILLS_DIR,
    })

    const secondCallMessages = mockChat.mock.calls[1][0].messages as Array<{ role: string; content: string }>
    const toolMsg = secondCallMessages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toMatch(/config\.tools\.editAllowlist is empty/)
  })

  it('Edit tools are discovered by discoverToolDefinitions and passed to chat()', async () => {
    mockChat.mockResolvedValueOnce(noToolsResponseFinal('Hi.'))
    await agentLoop({
      userMessage: 'hello',
      conversationHistory: [],
      context: {},
      model: 'qwen3.6',
      toolsDir: REPO_TOOLS_DIR,
      skillsDir: REPO_SKILLS_DIR,
    })
    const toolNames = (mockChat.mock.calls[0][0].tools as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    )
    expect(toolNames).toContain('read_file')
    expect(toolNames).toContain('edit_file')
    expect(toolNames).toContain('rewrite_file')
  })
})

const noToolsResponseFinal = (content: string) => noToolCalls(content)
