
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Setup mocks first
const mockOn = vi.fn()
const mockFetchChannel = vi.fn()
const mockSend = vi.fn().mockResolvedValue({ id: 'msg-id' }) // For text channel

const mockClient = {
  user: { id: 'bot-id' },
  on: mockOn,
  once: vi.fn(),
  channels: { fetch: mockFetchChannel },
  login: vi.fn().mockResolvedValue('token')
}

vi.mock('discord.js', async () => {
    return {
        Client: vi.fn(() => mockClient),
        GatewayIntentBits: { Guilds: 1, GuildMessages: 2, GuildVoiceStates: 3, MessageContent: 4 },
        Partials: { Channel: 1 },
        AttachmentBuilder: vi.fn((buf, opts) => ({ buffer: buf, name: opts.name }))
    }
})

// Mock dependencies
vi.mock('./recording/discord', () => ({
  getActiveRecording: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn()
}))
vi.mock('./recording/server', () => ({
  startTranscriptionServer: vi.fn()
}))
vi.mock('./database/db', () => ({
  initDB: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('fs/promises', () => ({
    default: {
        readFile: vi.fn().mockResolvedValue('mock-vtt-content'),
        stat: vi.fn().mockResolvedValue({})
    }
}))

import { startRecording, stopRecording, getActiveRecording } from './recording/discord'

describe('Auto-Recording Feature', () => {
    let handler: Function

    beforeEach(async () => {
        vi.resetModules()
        vi.clearAllMocks()
        
        process.env.ALWAYS_RECORDING_CHANNEL_ID = 'always-record-123'
        process.env.RECORDING_TRANSCRIPT_CHANNEL_ID = 'transcript-channel-456'
        process.env.DISCORD_TOKEN = 'mock-token'
        process.env.LLM_URL = 'http://mock-llm'

        // Re-import index to register listeners
        await import('./index')

        // Find the voiceStateUpdate handler
        const call = mockOn.mock.calls.find(c => c[0] === 'voiceStateUpdate')
        if (call) {
            handler = call[1]
        }
    })

    it('should register voiceStateUpdate listener', () => {
        expect(handler).toBeDefined()
    })

    it('should start recording when user joins target channel', async () => {
        const guildId = 'guild-1'
        const channelId = 'always-record-123'
        
        const oldState = { channelId: null, guild: { id: guildId }}
        const newState = { channelId: channelId, guild: { id: guildId } }

        // Mock channel fetch
        const mockVoiceChannel = {
            id: channelId,
            isVoiceBased: () => true,
            name: 'Voice Channel',
            members: {
                filter: (fn: any) => {
                    // Mock members: one human
                    const m = { user: { bot: false } } 
                    return { size: fn(m) ? 1 : 0 }
                }
            }
        }
        
        // Setup mock sequence:
        // 1. Initial fetch of voice channel
        mockFetchChannel.mockResolvedValueOnce(mockVoiceChannel)
        // 2. check voice channel for send support (fails)
        mockFetchChannel.mockResolvedValueOnce(mockVoiceChannel)
        // 3. check fallback channel (succeeds)
        const mockTextChannel = { id: 'transcript-channel-456', isTextBased: () => true, send: mockSend }
        mockFetchChannel.mockResolvedValueOnce(mockTextChannel)

        // No active recording
        vi.mocked(getActiveRecording).mockReturnValue(undefined)
        vi.mocked(startRecording).mockResolvedValue({ recordingId: 'rec-1', vttPath: 'path' } as any)

        await handler(oldState, newState)

        expect(startRecording).toHaveBeenCalledWith(guildId, mockVoiceChannel, false, 'transcript-channel-456')
        expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('Auto-recording started'))
    })

    it('should NOT start recording if already active', async () => {
        const guildId = 'guild-1'
        const channelId = 'always-record-123'
        
        const oldState = { channelId: null, guild: { id: guildId }}
        const newState = { channelId: channelId, guild: { id: guildId } }

        const mockVoiceChannel = {
            id: channelId,
            isVoiceBased: () => true,
            members: {
                filter: (fn: any) => ({ size: 1 })
            }
        }
        mockFetchChannel.mockResolvedValue(mockVoiceChannel)

        // Active recording in same guild
        vi.mocked(getActiveRecording).mockReturnValue({ recordingId: 'existing', channelId: 'other' } as any)

        await handler(oldState, newState)

        expect(startRecording).not.toHaveBeenCalled()
    })

    it('should stop recording when last user leaves target channel', async () => {
        const guildId = 'guild-1'
        const channelId = 'always-record-123'
        
        // User moving OUT of channel
        const oldState = { channelId: channelId, guild: { id: guildId }}
        const newState = { channelId: 'other', guild: { id: guildId } }

        // Mock channel fetch (now empty)
        const mockVoiceChannel = {
            id: channelId,
            isVoiceBased: () => true,
            name: 'Voice Channel',
            members: {
                filter: (fn: any) => ({ size: 0 }) // Empty
            }
        }
        mockFetchChannel.mockResolvedValueOnce(mockVoiceChannel) // for channel fetch

        // Mock fetch for stop logic "getSendableChannel"
        const mockTextChannel = { id: 'transcript-channel-456', isTextBased: () => true, send: mockSend }
        mockFetchChannel.mockResolvedValueOnce(mockTextChannel)

        // Active recording matches target channel
        vi.mocked(getActiveRecording).mockReturnValue({ recordingId: 'rec-1', channelId: channelId, vttPath: 'path' } as any)
        vi.mocked(stopRecording).mockResolvedValue({ recordingId: 'rec-1', textChannelId: 'transcript-channel-456', vttPath: 'path' } as any)

        await handler(oldState, newState)

        expect(stopRecording).toHaveBeenCalledWith(guildId)
        expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Auto-recording stopped') }))
    })
})
