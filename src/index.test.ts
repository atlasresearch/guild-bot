import fsp from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks Setup ---

const { mockClient, TEST_SESSION_DIR } = vi.hoisted(() => {
  const mockUser = { id: '123456789', tag: 'TestBot#1234' }
  const mockLogin = vi.fn().mockResolvedValue('token')
  const mockClientOn = vi.fn()
  const mockClient = {
    user: mockUser,
    on: mockClientOn,
    once: vi.fn(),
    login: mockLogin,
    channels: { fetch: vi.fn() }
  }
  const tmpdirNative = require('node:os').tmpdir() as string
  const TEST_SESSION_DIR = require('node:path').join(
    tmpdirNative,
    'test-sessions-' + Math.random().toString(36).slice(2),
  )
  return { mockClient, TEST_SESSION_DIR }
})

// 1. Mock Discord.js
vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js')
  return {
    ...actual,
    Client: vi.fn(() => mockClient),
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, GuildVoiceStates: 3, MessageContent: 4 },
    Partials: { Channel: 1 },
    AttachmentBuilder: vi.fn((buf, opts) => ({ buffer: buf, name: opts.name }))
  }
})

// 2. Mock the agent loop — replaces the old chooseToolForMention + answerQuestion path
vi.mock('./agent/loop', () => ({
  agentLoop: vi.fn().mockResolvedValue('Mock agent response'),
}))

// 3. Mock Audio/Heavy Processing
vi.mock('@guildbot/media', () => ({
  audioToTranscript: vi.fn().mockResolvedValue('mock-recording-id'),
  transcriptToDiagrams: vi.fn().mockResolvedValue({
    kumuPath: '/tmp/kumu.json',
    pngPath: '/tmp/diagram.png'
  })
}))

// 4. Mock Recording (Voice/UDP)
vi.mock('@guildbot/recording', () => ({
  getActiveRecording: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  startTranscriptionServer: vi.fn()
}))

// 5. Mock tool handler loading (for slash commands that call handlers directly)
vi.mock('./tools/discover', () => ({
  loadToolHandler: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ success: true, data: {} })
  ),
  discoverToolDefinitions: vi.fn().mockResolvedValue([]),
}))

// 6. Override the active guild's session dir so each test writes to an isolated
//    temp dir we can wipe in afterEach.
vi.mock('@guildbot/guild-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/guild-config')>()
  return {
    ...actual,
    paths: (guildDir?: string) => ({
      ...actual.paths(guildDir),
      sessions: TEST_SESSION_DIR,
      contextDir: require('node:path').join(TEST_SESSION_DIR, 'context'),
    }),
  }
})

// --- Imports ---

import { agentLoop } from './agent/loop'
import { handleMessage } from './index'

// --- Tests ---

describe('handleMessage', () => {
  let mockReply: any
  let mockMessage: any
  let mockChannel: any

  beforeEach(async () => {
    vi.clearAllMocks()

    await fsp.mkdir(TEST_SESSION_DIR, { recursive: true })

    mockReply = {
      edit: vi.fn(),
      delete: vi.fn(),
      channel: { isThread: () => false, id: 'channel-id' }
    }

    mockChannel = {
      isThread: () => false,
      sendTyping: vi.fn(),
      id: 'channel-id',
      fetchStarterMessage: vi.fn(),
      send: vi.fn().mockResolvedValue(mockReply)
    }

    mockMessage = {
      id: 'msg-1',
      author: { bot: false, id: 'user-1' },
      system: false,
      content: '<@123456789> hello',
      mentions: { has: vi.fn().mockReturnValue(true) },
      channel: mockChannel,
      channelId: 'channel-id',
      guildId: 'guild-id',
      reference: null,
      guild: { id: 'guild-id' },
      attachments: new Map(),
      reply: vi.fn().mockResolvedValue(mockReply),
      startThread: vi.fn().mockResolvedValue({
        id: 'thread-id',
        send: vi.fn().mockResolvedValue(mockReply)
      }),
      fetchReference: vi.fn()
    }

    mockMessage.attachments.first = () => {
      const iter = mockMessage.attachments.values()
      const res = iter.next()
      return res.done ? undefined : res.value
    }

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map(),
      arrayBuffer: async () => Buffer.from('file-content'),
      text: async () => 'file-content'
    } as any)
  })

  afterEach(async () => {
    await fsp.rm(TEST_SESSION_DIR, { recursive: true, force: true }).catch(() => {})
  })

  // --- Entry conditions ---

  it('ignores messages from bots', async () => {
    mockMessage.author.bot = true
    await handleMessage(mockMessage)
    expect(mockMessage.reply).not.toHaveBeenCalled()
    expect(mockMessage.startThread).not.toHaveBeenCalled()
  })

  it('ignores system messages', async () => {
    mockMessage.system = true
    await handleMessage(mockMessage)
    expect(mockMessage.reply).not.toHaveBeenCalled()
  })

  it('ignores messages where bot is not mentioned and no existing context', async () => {
    mockMessage.mentions.has.mockReturnValue(false)
    await handleMessage(mockMessage)
    expect(mockMessage.reply).not.toHaveBeenCalled()
  })

  // --- Thread creation ---

  it('creates a new thread if mentioned in a text channel', async () => {
    mockMessage.content = '<@123456789> start a topic'
    await handleMessage(mockMessage)

    expect(mockMessage.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'start a topic',
        autoArchiveDuration: 60
      })
    )
    expect(mockMessage.reply).not.toHaveBeenCalled()
  })

  it('replies directly if already in a thread', async () => {
    mockMessage.channel.isThread = () => true
    await handleMessage(mockMessage)

    expect(mockMessage.startThread).not.toHaveBeenCalled()
    expect(mockMessage.reply).toHaveBeenCalledWith('Thinking...')
  })

  // --- Agent loop routing ---

  it('routes @mention to agentLoop and posts response', async () => {
    vi.mocked(agentLoop).mockResolvedValue('Here is my answer.')
    mockMessage.content = '<@123456789> what is the meaning of life?'

    await handleMessage(mockMessage)

    expect(agentLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.stringContaining('what is the meaning of life'),
        conversationHistory: [],
        context: expect.objectContaining({
          guildId: 'guild-id',
          channelId: 'channel-id',
          userId: 'user-1',
        }),
      })
    )
    expect(mockReply.edit).toHaveBeenCalledWith({ content: 'Here is my answer.' })
  })

  it('sends long answers as file attachments', async () => {
    const longAnswer = 'A'.repeat(2001)
    vi.mocked(agentLoop).mockResolvedValue(longAnswer)

    await handleMessage(mockMessage)

    expect(mockReply.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '',
        files: expect.arrayContaining([
          expect.objectContaining({ name: 'answer.txt' })
        ])
      })
    )
  })

  it('handles agentLoop errors gracefully', async () => {
    vi.mocked(agentLoop).mockRejectedValue(new Error('LLM down'))

    await handleMessage(mockMessage)

    expect(mockReply.edit).toHaveBeenCalledWith(expect.stringContaining('Error processing your question'))
    expect(mockReply.edit).toHaveBeenCalledWith(expect.stringContaining('LLM down'))
  })

  it('gathers referenced message content into context', async () => {
    mockMessage.reference = { messageId: 'ref-msg-id' }
    mockMessage.fetchReference.mockResolvedValue({
      id: 'ref-msg-id',
      content: 'Original question about testing',
      attachments: new Map(),
      author: { bot: false }
    })

    await handleMessage(mockMessage)

    expect(agentLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.stringContaining('Original question about testing'),
      })
    )
  })
})
