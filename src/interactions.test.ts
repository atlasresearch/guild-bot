
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import * as ragService from './services/rag'

// Mock dependencies
vi.mock('./services/rag', () => ({
  search: vi.fn(),
  ask: vi.fn()
}))

// Mock discord.js things (simplified)
vi.mock('discord.js', async () => {
    const actual = await vi.importActual('discord.js')
    return {
        ...actual,
        AttachmentBuilder: vi.fn(),
        Client: vi.fn().mockImplementation(() => ({
          once: vi.fn(),
          on: vi.fn(),
          login: vi.fn().mockResolvedValue('token')
        }))
    }
})

describe('handleInteraction', () => {
  let mockInteraction: any
  let mockThread: any
  let mockMessage: any
  let handleInteraction: any

  beforeAll(() => {
    process.env.DISCORD_TOKEN = 'mock-token'
    process.env.LLM_URL = 'http://mock-llm' 
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    
    // Dynamic import to avoid top-level execution issues
    const index = await import('./index')
    handleInteraction = index.handleInteraction

    mockThread = {
      send: vi.fn().mockResolvedValue({}),
    }

    mockMessage = {
      startThread: vi.fn().mockResolvedValue(mockThread),
    }

    mockInteraction = {
      isChatInputCommand: () => true,
      commandName: 'guild',
      guildId: 'guild-123',
      channelId: 'channel-123',
      options: {
        getSubcommand: vi.fn(),
        getString: vi.fn(),
      },
      deferReply: vi.fn().mockResolvedValue({}),
      editReply: vi.fn().mockResolvedValue({}),
      fetchReply: vi.fn().mockResolvedValue(mockMessage),
    }
  })

  it('should format search results with links and send as single message if short', async () => {
    mockInteraction.options.getSubcommand.mockReturnValue('search')
    mockInteraction.options.getString.mockReturnValue('test query')
    
    const mockResults = [
      {
        id: 'msg-1',
        user_id: 'user-1',
        content: 'Hello world',
        timestamp: 1600000000000,
        guild_id: 'guild-1',
        channel_id: 'channel-1'
      }
    ]
    vi.mocked(ragService.search).mockResolvedValue(mockResults)

    await handleInteraction(mockInteraction)

    expect(ragService.search).toHaveBeenCalledWith('guild-123', 'test query')
    
    // Check formatting
    const expectedLink = 'https://discord.com/channels/guild-1/channel-1/msg-1'
    const calls = mockInteraction.editReply.mock.calls
    const replyContent = calls[0][0]
    
    expect(replyContent).toContain(expectedLink)
    expect(replyContent).toContain('Hello world')
    expect(replyContent).not.toContain('<@user-1>')
    expect(replyContent.trim().startsWith('https://discord.com')).toBe(true)
    
    // Should NOT create thread
    expect(mockMessage.startThread).not.toHaveBeenCalled()
  })

  it('should truncate multi-line content to 2 lines', async () => {
    mockInteraction.options.getSubcommand.mockReturnValue('search')
    mockInteraction.options.getString.mockReturnValue('test query')
    
    const mockResults = [
      {
        id: 'msg-1',
        user_id: 'user-1',
        content: 'Line 1\nLine 2\nLine 3\nLine 4',
        timestamp: 1600000000000,
        guild_id: 'guild-1',
        channel_id: 'channel-1'
      }
    ]
    vi.mocked(ragService.search).mockResolvedValue(mockResults)

    await handleInteraction(mockInteraction)
    
    const calls = mockInteraction.editReply.mock.calls
    const replyContent = calls[0][0]

    expect(replyContent).toContain('Line 1')
    expect(replyContent).toContain('Line 2')
    expect(replyContent).toContain('...')
    expect(replyContent).not.toContain('Line 3')
  })

  it('should create a thread and send chunks if results are long', async () => {
    mockInteraction.options.getSubcommand.mockReturnValue('search')
    mockInteraction.options.getString.mockReturnValue('test query')
    
    // Create enough results to exceed 2000 chars
    const longContent = 'a'.repeat(500)
    const mockResults = Array(5).fill(null).map((_, i) => ({
      id: `msg-${i}`,
      user_id: `user-${i}`,
      content: longContent,
      timestamp: 1600000000000,
      guild_id: 'guild-1',
      channel_id: 'channel-1'
    }))
    
    vi.mocked(ragService.search).mockResolvedValue(mockResults)

    await handleInteraction(mockInteraction)

    // Should inform user about thread
    expect(mockInteraction.editReply).toHaveBeenCalledWith(expect.stringContaining('Creating a thread'))
    
    // Should create thread
    expect(mockMessage.startThread).toHaveBeenCalledWith({
        name: 'Search: test query',
        autoArchiveDuration: 60
    })
    
    // Should send to thread
    expect(mockThread.send).toHaveBeenCalled()
  })
})
