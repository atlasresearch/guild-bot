
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock messageProcessor
const mockDeleteMessage = vi.fn()
vi.mock('./services/messageProcessor', () => ({
  deleteMessage: mockDeleteMessage,
  processMessage: vi.fn(),
  syncChannel: vi.fn(),
  processDiscordMessage: vi.fn()
}))

// Mock discord.js Client
const mockOn = vi.fn()
vi.mock('discord.js', async () => {
    const actual = await vi.importActual('discord.js')
    return {
        ...actual,
        Client: vi.fn().mockImplementation(() => ({
          on: mockOn,
          once: vi.fn(),
          login: vi.fn().mockResolvedValue('token')
        }))
    }
})

describe('Index - Message Delete Event', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DISCORD_TOKEN = 'mock-token'
    process.env.LLM_URL = 'http://mock-llm' 
  })

  it('should register messageDelete handler and calling deleteMessage', async () => {
    // Import index to trigger client creation and event registration
    await import('./index')

    // Check if 'messageDelete' listener was registered
    const calls = mockOn.mock.calls
    const deleteHandler = calls.find(call => call[0] === 'messageDelete')
    expect(deleteHandler).toBeDefined()

    const handler = deleteHandler[1]

    // Simulate event
    const mockMsg = { id: 'deleted-msg-id' }
    await handler(mockMsg)

    expect(mockDeleteMessage).toHaveBeenCalledWith('deleted-msg-id')
  })
})
