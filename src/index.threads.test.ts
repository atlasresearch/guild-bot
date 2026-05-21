// Integration tests for plan 005 thread continuity in the Discord dispatcher.
//
// do NOT mock @guildbot/threads or @guildbot/discord-index — use real
// modules against a temp GUILD_DIR so the file-on-disk semantics are exercised.

import fsp from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockClient, TEST_GUILD_DIR } = vi.hoisted(() => {
  const mockUser = { id: '999000111', tag: 'TestBot#0001' }
  const mockClient = {
    user: mockUser,
    on: vi.fn(),
    once: vi.fn(),
    login: vi.fn().mockResolvedValue('token'),
    channels: { fetch: vi.fn() },
  }
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-threads-'))
  return { mockClient, TEST_GUILD_DIR: dir as string }
})

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js')
  return {
    ...actual,
    Client: vi.fn(() => mockClient),
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, GuildVoiceStates: 3, MessageContent: 4 },
    Partials: { Channel: 1 },
    AttachmentBuilder: vi.fn((buf, opts) => ({ buffer: buf, name: opts.name })),
  }
})

vi.mock('./agent/loop', () => ({
  agentLoop: vi.fn(),
}))

vi.mock('@guildbot/media', () => ({
  audioToTranscript: vi.fn(),
  transcriptToDiagrams: vi.fn(),
}))

vi.mock('@guildbot/recording', () => ({
  getActiveRecording: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  startTranscriptionServer: vi.fn(),
}))

vi.mock('./tools/discover', () => ({
  loadToolHandler: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue({ success: true, data: {} })),
  discoverToolDefinitions: vi.fn().mockResolvedValue([]),
}))

vi.mock('@guildbot/guild-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/guild-config')>()
  return {
    ...actual,
    paths: (guildDir?: string) => actual.paths(guildDir ?? TEST_GUILD_DIR),
  }
})

import { agentLoop } from './agent/loop'
import { handleMessage } from './index'
import { listThreads, readMessages } from '@guildbot/threads'
import { resolveDiscord, bindDiscord } from '@guildbot/discord-index'

const buildMessage = (overrides: any = {}) => {
  const reply = {
    id: 'reply-id-' + Math.random().toString(36).slice(2, 7),
    edit: vi.fn(),
    delete: vi.fn(),
    channel: { isThread: () => false, id: 'channel-1' },
  }
  const channel = {
    isThread: () => false,
    sendTyping: vi.fn(),
    id: 'channel-1',
    type: 0,
    fetchStarterMessage: vi.fn(),
    send: vi.fn().mockResolvedValue(reply),
  }
  const attachments = new Map() as any
  attachments.first = () => undefined
  const msg = {
    id: 'msg-' + Math.random().toString(36).slice(2, 7),
    author: { bot: false, id: 'user-1' },
    system: false,
    content: `<@${mockClient.user.id}> hello`,
    mentions: { has: vi.fn().mockReturnValue(true) },
    channel,
    channelId: 'channel-1',
    guildId: 'guild-1',
    reference: null,
    guild: { id: 'guild-1' },
    attachments,
    reply: vi.fn().mockResolvedValue(reply),
    startThread: vi.fn().mockResolvedValue({
      id: 'discord-thread-1',
      send: vi.fn().mockResolvedValue(reply),
    }),
    fetchReference: vi.fn(),
    ...overrides,
  }
  return { msg, reply, channel }
}

describe('dispatcher → @guildbot/threads integration', () => {
  beforeEach(async () => {
    await fsp.rm(`${TEST_GUILD_DIR}/threads`, { recursive: true, force: true })
    await fsp.rm(`${TEST_GUILD_DIR}/sessions`, { recursive: true, force: true })
    await fsp.mkdir(`${TEST_GUILD_DIR}/sessions`, { recursive: true })
    vi.mocked(agentLoop).mockReset()
    vi.mocked(agentLoop).mockResolvedValue('the answer')
  })

  afterEach(async () => {
    await fsp.rm(`${TEST_GUILD_DIR}/threads`, { recursive: true, force: true })
  })

  it('a fresh @mention creates a new guild-bot thread + binds the Discord thread', async () => {
    const { msg } = buildMessage()
    await handleMessage(msg as any)

    const threads = await listThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0].guildId).toBe('discord:guild-1')

    const bound = await resolveDiscord({ kind: 'thread', key: 'discord-thread-1' })
    expect(bound).toBe(threads[0].id)
  })

  it('the user turn is persisted with sourceRef.platform=discord', async () => {
    const { msg } = buildMessage({ id: 'msg-source-ref' })
    await handleMessage(msg as any)

    const [t] = await listThreads()
    const msgs = await readMessages(t.id)
    const userMsg = msgs.find((m) => m.role === 'user')!
    expect(userMsg.sourceRef?.platform).toBe('discord')
    expect(userMsg.sourceRef?.messageId).toBe('msg-source-ref')
    expect(userMsg.sourceRef?.userId).toBe('user-1')
    expect(userMsg.sourceRef?.channelId).toBe('channel-1')
  })

  it('the assistant reply id is bound back to the thread', async () => {
    const { msg, reply } = buildMessage()
    await handleMessage(msg as any)
    const [t] = await listThreads()
    expect(await resolveDiscord({ kind: 'reply', key: reply.id })).toBe(t.id)
  })

  it('a second mention in the same Discord thread continues the conversation', async () => {
    // First turn — creates the thread.
    const { msg: m1 } = buildMessage({ content: `<@${mockClient.user.id}> first turn` })
    await handleMessage(m1 as any)
    const [t] = await listThreads()

    // Bind the thread channel (already done by handler) — verify.
    expect(await resolveDiscord({ kind: 'thread', key: 'discord-thread-1' })).toBe(t.id)

    // Second turn in the same Discord thread channel.
    const followup = buildMessage({
      content: 'follow-up question',
      channelId: 'discord-thread-1',
    })
    followup.msg.mentions.has.mockReturnValue(false)
    ;(followup.msg.channel as any).id = 'discord-thread-1'
    ;(followup.msg.channel as any).isThread = () => true

    // Capture what history the loop saw on the second turn.
    let secondTurnHistory: any[] = []
    vi.mocked(agentLoop).mockImplementationOnce(async (opts: any) => {
      secondTurnHistory = opts.conversationHistory
      return 'second answer'
    })
    await handleMessage(followup.msg as any)

    // The second turn's history includes the first turn's user + assistant
    // (persisted by appendMessage + onMessage on turn 1).
    const roles = secondTurnHistory.map((m: any) => m.role)
    expect(roles).toContain('user')
    // assistant turn was persisted by onMessage — but agentLoop was mocked on
    // turn 1 so onMessage was never called from inside the mock. The dispatcher
    // does NOT persist the assistant turn directly; that flows through
    // onMessage. So we only assert the user turn from turn 1 is present.
    expect(secondTurnHistory.find((m: any) => m.role === 'user')?.content).toContain('first turn')
  })

  it('replying to a bound assistant message resolves to the same thread (no Discord thread channel)', async () => {
    // Simulate an existing reply binding without a Discord thread channel.
    const { msg: setupMsg, reply: setupReply } = buildMessage()
    await handleMessage(setupMsg as any)
    const [t] = await listThreads()
    expect(await resolveDiscord({ kind: 'reply', key: setupReply.id })).toBe(t.id)

    // User replies to that bot message in a non-thread channel.
    const followup = buildMessage({
      content: 'follow-up via reply chain',
      reference: { messageId: setupReply.id },
    })
    followup.msg.mentions.has.mockReturnValue(false)

    let resolvedHistory: any[] = []
    vi.mocked(agentLoop).mockImplementationOnce(async (opts: any) => {
      resolvedHistory = opts.conversationHistory
      return 'reply chain answer'
    })
    await handleMessage(followup.msg as any)

    // No new thread; same one in use.
    expect((await listThreads()).length).toBe(1)
    // History on this follow-up contains the prior user turn from setup.
    expect(resolvedHistory.find((m: any) => m.role === 'user')).toBeDefined()
  })

  it('bails when no mention and no bound thread', async () => {
    const { msg } = buildMessage()
    msg.mentions.has.mockReturnValue(false)
    await handleMessage(msg as any)
    expect(await listThreads()).toEqual([])
    expect(msg.reply).not.toHaveBeenCalled()
  })

  it('in a bound Discord thread, responds even without a mention', async () => {
    // Pre-bind a thread channel.
    const { msg: setup } = buildMessage()
    await handleMessage(setup as any)
    const [t] = await listThreads()
    // Simulate the same channel as a thread; bind already done by handler.
    await bindDiscord({ kind: 'thread', key: 'discord-thread-1', threadId: t.id })

    const followup = buildMessage({ channelId: 'discord-thread-1' })
    ;(followup.msg.channel as any).id = 'discord-thread-1'
    ;(followup.msg.channel as any).isThread = () => true
    followup.msg.mentions.has.mockReturnValue(false)

    await handleMessage(followup.msg as any)
    expect(followup.msg.reply).toHaveBeenCalledWith('Thinking...')
  })

  it('onMessage errors abort the dispatcher gracefully (caller is informed)', async () => {
    // Mock agentLoop to call its onMessage callback with one that throws.
    const { msg, reply } = buildMessage()
    vi.mocked(agentLoop).mockImplementationOnce(async (opts: any) => {
      // Make onMessage throw to simulate disk failure.
      await opts.onMessage({ role: 'assistant', content: 'hi' }).catch((err: any) => {
        throw err
      })
      return 'should not get here'
    })

    // Sabotage threads/ to make appendMessage fail.
    await fsp.rm(`${TEST_GUILD_DIR}/threads`, { recursive: true, force: true })
    // Re-handle from scratch — first call will create a thread, but we'll
    // wipe it again before agentLoop's onMessage fires. Simpler: replace
    // appendMessage by passing an onMessage that rejects.
    vi.mocked(agentLoop).mockReset()
    vi.mocked(agentLoop).mockImplementationOnce(async (opts: any) => {
      await opts.onMessage({ role: 'assistant', content: 'oops' })
      // not reached if the await above throws
      return 'unreached'
    })

    // Wipe again to make the inner appendMessage call fail (no thread dir).
    // Then point onMessage at a now-deleted thread.
    const { msg: msg2, reply: reply2 } = buildMessage()
    await fsp.mkdir(`${TEST_GUILD_DIR}/threads`, { recursive: true })

    // Pre-create a thread, then delete it right before onMessage runs.
    vi.mocked(agentLoop).mockReset()
    vi.mocked(agentLoop).mockImplementationOnce(async (opts: any) => {
      // Force the appendMessage (within onMessage) to fail by removing the thread dir.
      await fsp.rm(`${TEST_GUILD_DIR}/threads`, { recursive: true, force: true })
      await opts.onMessage({ role: 'assistant', content: 'will fail' })
      return 'unreached'
    })
    await handleMessage(msg2 as any)
    // The dispatcher catches and edits the reply with the error.
    expect(reply2.edit).toHaveBeenCalledWith(expect.stringContaining('Error processing your question'))
  })
})
