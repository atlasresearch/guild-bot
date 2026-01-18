import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as messageProcessor from './services/messageProcessor'

// Mock dependencies
vi.mock('./services/rag', () => ({
  search: vi.fn(),
  ask: vi.fn()
}))

vi.mock('./services/messageProcessor', () => ({
  addTags: vi.fn(),
  removeTags: vi.fn(),
  processMessage: vi.fn(),
  processDiscordMessage: vi.fn()
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

describe('handleInteraction - Tagging', () => {
  let mockInteraction: any
  let handleInteraction: any
  let mockChannel: any
  let mockFetchedMessages: any

  beforeAll(() => {
    process.env.DISCORD_TOKEN = 'mock-token'
    process.env.LLM_URL = 'http://mock-llm'
  })

  beforeEach(async () => {
    vi.clearAllMocks()

    // Dynamic import to avoid top-level execution issues
    const index = await import('./index')
    handleInteraction = index.handleInteraction

    mockFetchedMessages = {
      first: vi.fn()
    }

    mockChannel = {
      messages: {
        fetch: vi.fn().mockResolvedValue(mockFetchedMessages)
      },
      isTextBased: vi.fn().mockReturnValue(true)
    }

    mockInteraction = {
      isChatInputCommand: vi.fn().mockReturnValue(true),
      commandName: 'guild',
      options: {
        getSubcommand: vi.fn().mockReturnValue('tag'),
        getString: vi.fn((key) => {
          if (key === 'tags') return 'tag1, tag2'
          return null
        }),
        getBoolean: vi.fn().mockReturnValue(false)
      },
      deferReply: vi.fn().mockResolvedValue({}),
      editReply: vi.fn().mockResolvedValue({}),
      guildId: 'guild-1',
      channelId: 'channel-1',
      id: 'interaction-1',
      user: { id: 'user-1' },
      channel: mockChannel,
      guild: {
        channels: {
          fetch: vi.fn().mockResolvedValue(mockChannel)
        }
      },
      createdTimestamp: 1000
    }
  })

  it('should tag the latest message if no message identifier is provided', async () => {
    // Setup last message
    const lastMessage = { id: 'msg-latest', content: 'Last message' }
    mockFetchedMessages.first.mockReturnValue(lastMessage)

    await handleInteraction(mockInteraction)

    // Verify it fetched the channel messages
    expect(mockInteraction.channel.messages.fetch).toHaveBeenCalledWith({ limit: 1 })

    // Verify it ensured the message is processed
    expect(messageProcessor.processDiscordMessage).toHaveBeenCalledWith(lastMessage)

    // Verify it tagged the latest message
    expect(messageProcessor.addTags).toHaveBeenCalledWith('msg-latest', ['tag1', 'tag2'])

    expect(mockInteraction.editReply).toHaveBeenCalledWith(expect.stringContaining('Tagged message msg-latest'))
  })

  it('should handle optional message argument correctly (valid ID)', async () => {
    mockInteraction.options.getString.mockImplementation((key: string) => {
      if (key === 'tags') return 'tag1'
      if (key === 'message') return '123456789' // Explicit ID
      return null
    })

    await handleInteraction(mockInteraction)

    // Should NOT fetch channel history since we have ID
    expect(mockInteraction.channel.messages.fetch).not.toHaveBeenCalledWith({ limit: 1 })

    expect(messageProcessor.addTags).toHaveBeenCalledWith('123456789', ['tag1'])
  })

  it('should treat plain text in message arg as content to save and tag', async () => {
    mockInteraction.options.getString.mockImplementation((key: string) => {
      if (key === 'tags') return 'tag1'
      if (key === 'message') return 'Here is some content'
      return null
    })

    await handleInteraction(mockInteraction)

    expect(messageProcessor.processMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Here is some content',
        type: 'user-tagged'
      })
    )

    // ID of the interaction is used for new content
    expect(messageProcessor.addTags).toHaveBeenCalledWith(mockInteraction.id, ['tag1'])
  })

  it('should support removing tags', async () => {
    const lastMessage = { id: 'msg-latest' }
    mockFetchedMessages.first.mockReturnValue(lastMessage)

    mockInteraction.options.getBoolean.mockReturnValue(true) // remove = true

    await handleInteraction(mockInteraction)

    expect(messageProcessor.removeTags).toHaveBeenCalledWith('msg-latest', ['tag1', 'tag2'])
    expect(mockInteraction.editReply).toHaveBeenCalledWith(expect.stringContaining('Untagged message msg-latest'))
  })

  it('should inform user if no latest message found', async () => {
    mockFetchedMessages.first.mockReturnValue(null) // No messages

    await handleInteraction(mockInteraction)

    expect(mockInteraction.editReply).toHaveBeenCalledWith('Could not determine message to tag.')
  })
})
