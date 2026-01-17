import fsp from 'node:fs/promises'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks Setup ---

const { mockClient } = vi.hoisted(() => {
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
  return { mockClient }
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

// 2. Mock Agent Workflow
vi.mock('@hexafield/agent-workflow', async () => {
  const actual = await vi.importActual('@hexafield/agent-workflow')
  return {
    ...actual,
    promptSession: vi.fn().mockResolvedValue({ parts: ['Mock LLM Answer'] }),
    runAgentWorkflow: vi.fn().mockResolvedValue({
      result: Promise.resolve({
        rounds: [
          {
            steps: {
              integrator: {
                parsed: {
                  insights: [{ summary: 'Mock Insight' }],
                  actionItems: [{ task: 'Mock Action' }],
                  decisions: [{ decision: 'Mock Decision' }],
                  openQuestions: [{ question: 'Mock Question' }]
                }
              }
            }
          }
        ]
      })
    }),
    createSession: vi.fn().mockResolvedValue({ id: 'mock-session-id', title: 'test session' }),
    getSession: vi.fn().mockResolvedValue({ id: 'mock-session-id', title: 'test session' }),
    extractResponseText: vi.fn().mockReturnValue('Mock LLM Answer')
  }
})

// 3. Mock Tools Abstraction (Decision Logic)
vi.mock('./workflows/tools', () => ({
  chooseToolForMention: vi.fn().mockResolvedValue({ tool: 'none' })
}))

// 4. Mock Audio/Heavy Processing
vi.mock('./audioToDiagram', () => ({
  audioToTranscript: vi.fn().mockResolvedValue('mock-recording-id'),
  transcriptToDiagrams: vi.fn().mockResolvedValue({
    kumuPath: '/tmp/kumu.json',
    pngPath: '/tmp/diagram.png'
  })
}))

// 5. Mock Recording (Voice/UDP)
vi.mock('./recording/discord', () => ({
  getActiveRecording: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn()
}))
vi.mock('./recording/server', () => ({
  startTranscriptionServer: vi.fn()
}))

// --- Imports ---

import * as AgentWorkflow from '@hexafield/agent-workflow'
import { ASKQUESTION_CONSTANTS, UNIVERSE } from './askQuestion'
import * as AudioToDiagram from './audioToDiagram'
import { handleMessage } from './index'
import * as Tools from './workflows/tools'

// --- Globals & Helpers ---

// Mock file system for diagrams
const MOCK_KUMU_PATH = '/tmp/kumu.json'
const MOCK_PNG_PATH = '/tmp/diagram.png'

describe('handleMessage Features', () => {
  // Common Mock Objects
  let mockReply: any
  let mockMessage: any
  let mockChannel: any
  const TEST_SESSION_DIR = path.join(process.cwd(), '.tmp', 'test-sessions-' + Math.random().toString(36).slice(2))

  beforeEach(async () => {
    vi.clearAllMocks()

    // Setup file system for outputs
    ASKQUESTION_CONSTANTS.SESSION_DIR = TEST_SESSION_DIR
    await fsp.mkdir(TEST_SESSION_DIR, { recursive: true })

    // Create dummy files for diagram tool
    await fsp.writeFile(MOCK_KUMU_PATH, '{"mock":"kumu"}')
    await fsp.writeFile(MOCK_PNG_PATH, Buffer.from('mock png'))

    // Setup Discord Object Mocks
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
      author: { bot: false },
      system: false,
      content: '<@123456789> hello',
      mentions: { has: vi.fn().mockReturnValue(true) },
      channel: mockChannel,
      channelId: 'channel-id',
      reference: null,
      guild: { id: 'guild-id' },
      attachments: new Map(), // start with Map
      reply: vi.fn().mockResolvedValue(mockReply),
      startThread: vi.fn().mockResolvedValue({
        id: 'thread-id',
        send: vi.fn().mockResolvedValue(mockReply)
      }),
      fetchReference: vi.fn()
    }

    // Add Collection-like methods
    mockMessage.attachments.first = () => {
      const iter = mockMessage.attachments.values()
      const res = iter.next()
      return res.done ? undefined : res.value
    }

    // Mock global fetch
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

  // --- 1. Entry Conditions ---

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

  // --- 2. Interaction Mode (Thread vs Reply) ---

  it('creates a new thread if mentioned in a text channel (not thread, no reply)', async () => {
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
    expect(mockMessage.reply).toHaveBeenCalledWith(expect.stringContaining('Optimizing'))
  })

  it('replies directly if message is a reply to another message', async () => {
    mockMessage.reference = { messageId: 'ref-msg-id' }
    mockMessage.fetchReference.mockResolvedValue({
      id: 'ref-msg-id',
      content: 'Original question',
      attachments: new Map(),
      author: { bot: false }
    })
    await handleMessage(mockMessage)

    expect(mockMessage.startThread).not.toHaveBeenCalled()
    expect(mockMessage.reply).toHaveBeenCalledWith(expect.stringContaining('Optimizing'))
  })

  // --- 3. Context Gathering & 4. Intelligent Tool Selection ---

  it('gathers context and selects default tool (LLM)', async () => {
    mockMessage.content = 'What is the meaning of life?'

    vi.mocked(Tools.chooseToolForMention).mockResolvedValue({ tool: 'none' })

    await handleMessage(mockMessage)

    expect(mockReply.edit).toHaveBeenCalledWith('Thinking...')
    expect(AgentWorkflow.promptSession).toHaveBeenCalled()
    expect(mockReply.edit).toHaveBeenCalledWith(expect.objectContaining({ content: 'Mock LLM Answer' }))
  })

  it('handles attachments in context', async () => {
    const attMap = new Map() as any
    attMap.set('1', { url: 'http://foo/doc.txt', name: 'doc.txt', contentType: 'text/plain' })
    mockMessage.attachments = attMap

    await handleMessage(mockMessage)

    // Check if fetch was called.
    // We check partial match mainly to be safe if environment wraps it
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('http://foo/doc.txt'))
    expect(AgentWorkflow.promptSession).toHaveBeenCalled()
  })

  // --- 5. Feature Paths (Tools) ---

  describe('Tool: Diagram', () => {
    it('executes diagram flow when tool="diagram"', async () => {
      vi.mocked(Tools.chooseToolForMention).mockResolvedValue({ tool: 'diagram' })

      const attMap = new Map() as any
      attMap.set('1', { url: 'http://foo/audio.mp3', name: 'audio.mp3', contentType: 'audio/mpeg' })
      mockMessage.attachments = attMap
      mockMessage.attachments.first = () => attMap.get('1')

      await handleMessage(mockMessage)

      expect(mockReply.edit).toHaveBeenCalledWith('Using diagram tool...')
      expect(mockReply.edit).toHaveBeenCalledWith('Generating diagram from the provided audio…')

      expect(AudioToDiagram.audioToTranscript).toHaveBeenCalledWith(
        UNIVERSE,
        'http://foo/audio.mp3',
        expect.any(Function)
      )
      expect(AudioToDiagram.transcriptToDiagrams).toHaveBeenCalled()

      expect(mockReply.edit).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Here is your diagram'),
          files: expect.arrayContaining([
            expect.objectContaining({ name: 'kumu.json' }),
            expect.objectContaining({ name: 'diagram.png' })
          ])
        })
      )
    })

    it('handles missing audio for diagram tool', async () => {
      vi.mocked(Tools.chooseToolForMention).mockResolvedValue({ tool: 'diagram' })
      mockMessage.attachments.first = () => null
      mockMessage.content = 'make a diagram'

      await handleMessage(mockMessage)

      expect(mockReply.edit).toHaveBeenCalledWith(
        'I could not find an audio attachment or URL to generate a diagram from.'
      )
    })
  })

  describe('Tool: Transcribe', () => {
    it('executes transcription flow when tool="transcribe"', async () => {
      vi.mocked(Tools.chooseToolForMention).mockResolvedValue({ tool: 'transcribe' })
      mockMessage.content = 'transcribe https://example.com/audio.mp3'

      const mockTranscript = 'This is the transcript text.'
      // Needs to match CHAT_DIR in path.ts which is .tmp/chat-sessions
      const vttDir = path.resolve(process.cwd(), '.tmp', 'chat-sessions', UNIVERSE, 'mock-recording-id')
      await fsp.mkdir(vttDir, { recursive: true })
      await fsp.writeFile(path.join(vttDir, 'audio.vtt'), mockTranscript)

      await handleMessage(mockMessage)

      expect(mockReply.edit).toHaveBeenCalledWith('Transcribing audio…')
      expect(AudioToDiagram.audioToTranscript).toHaveBeenCalled()
      expect(mockReply.edit).toHaveBeenCalledWith({ content: `Transcript:\n\n${mockTranscript}` })
    })
  })

  describe('Tool: Meeting Summary', () => {
    it('executes summary flow when tool="meeting_summarise"', async () => {
      vi.mocked(Tools.chooseToolForMention).mockResolvedValue({ tool: 'meeting_summarise' })

      mockMessage.reference = { messageId: 'ref-1' }
      mockMessage.fetchReference.mockResolvedValue({
        id: 'ref-1',
        content: 'Speaker: This is the meeting context.',
        attachments: new Map(),
        author: { bot: false }
      })

      await handleMessage(mockMessage)

      expect(mockReply.edit).toHaveBeenCalledWith('Generating meeting summary…')
      expect(mockReply.edit).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Insights') })
      )
      expect(mockReply.edit).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Mock Insight') })
      )
    })
  })

  // --- 6. Resilience ---

  it('handles errors gracefully', async () => {
    // Force error inside business logic
    vi.mocked(Tools.chooseToolForMention).mockRejectedValue(new Error('Tool Picker Failed'))

    await handleMessage(mockMessage)

    expect(mockReply.edit).toHaveBeenCalledWith(expect.stringContaining('Error processing your question'))
  })

  it('extracts URL from referenced message content for transcription', async () => {
    vi.mocked(Tools.chooseToolForMention).mockResolvedValue({ tool: 'transcribe' })

    // Current message has no URL/Attachment
    mockMessage.content = 'transcribe this'

    // Referenced message has a URL in content
    const refUrl = 'https://example.com/audio.mp3'
    const refAttachments = new Map()
    ;(refAttachments as any).first = () => undefined

    mockMessage.reference = { messageId: 'ref-msg-id' }
    mockMessage.fetchReference.mockResolvedValue({
      id: 'ref-msg-id',
      content: `Check this out: ${refUrl}`,
      attachments: refAttachments,
      author: { bot: false }
    })

    // Setup transcript file expectation
    const vttDir = path.resolve(process.cwd(), '.tmp', 'chat-sessions', UNIVERSE, 'mock-recording-id')
    await fsp.mkdir(vttDir, { recursive: true })
    await fsp.writeFile(path.join(vttDir, 'audio.vtt'), 'Mock transcript')

    await handleMessage(mockMessage)

    // Expected flow
    expect(mockReply.edit).toHaveBeenCalledWith('Transcribing audio…')
    // Ensure the URL was passed to audioToTranscript
    expect(AudioToDiagram.audioToTranscript).toHaveBeenCalledWith(expect.any(String), refUrl, expect.any(Function))
  })
})
