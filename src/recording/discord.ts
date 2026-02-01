import { OpusEncoder } from '@discordjs/opus'
import {
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus
} from '@discordjs/voice'
import type { VoiceBasedChannel } from 'discord.js'
import { encode } from 'msgpackr'
import type { Readable } from 'node:stream'
import WebSocket from 'ws'
import { debug } from '../interfaces/logger'

type RecSession = {
  recordingId: string
  guildId: string
  channelId: string
  textChannelId?: string
  ws: WebSocket
  cleanup: () => Promise<void>
  done: Promise<{ recordingId: string; vttPath: string }>
  restoreNickname?: () => Promise<void>
  includeAudio: boolean
  cancelled?: boolean
}

const sessions = new Map<string, RecSession>() // by guildId

function utcStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export async function startRecording(
  guildId: string,
  channel: VoiceBasedChannel,
  includeAudio = false,
  textChannelId?: string
) {
  if (sessions.has(guildId)) throw new Error('Recording already active in this guild')

  const recordingId = `${channel.id}-${utcStamp()}`
  
  // Create a placeholder session to lock this guild immediately
  sessions.set(guildId, {
    recordingId: 'pending',
    guildId,
    channelId: channel.id,
    ws: null!,
    cleanup: async () => {},
    done: Promise.resolve({ recordingId: '', vttPath: '' }),
    includeAudio
  })
  
  try {
    const conn = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false
    })
    
    // Attach cleanup logic to the pending session so that if stopRecording() is called
    // while we are waiting, it can correctly destroy this connection.
    const pendingSession = sessions.get(guildId)
    if (pendingSession && pendingSession.recordingId === 'pending') {
      const originalCleanup = pendingSession.cleanup
      pendingSession.cleanup = async () => {
        try {
          conn.destroy()
        } catch {}
        return originalCleanup()
      }
    }

    await entersState(conn, VoiceConnectionStatus.Ready, 20_000)

    const isDev = process.env.NODE_ENV !== 'production'
  const defaultPort = isDev ? 8766 : 8765
  const port = Number(process.env.AUDIO_WS_PORT) || defaultPort
  const ws = new WebSocket(`ws://localhost:${port}`)
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res())
    ws.once('error', (e) => rej(e))
  })

  // Promise resolves when server signals recording completion
  let resolveDone!: (v: { recordingId: string; vttPath: string }) => void
  const done = new Promise<{ recordingId: string; vttPath: string }>((resolve) => (resolveDone = resolve))
  ws.on('message', (data: WebSocket.RawData) => {
    try {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
      const msg = JSON.parse(text)
      if (msg && msg.type === 'done' && msg.recordingId === recordingId) {
        resolveDone({ recordingId, vttPath: msg.vttPath ? String(msg.vttPath) : '' })
      }
    } catch {}
  })

  const receiver = conn.receiver
  const decoders = new Map<string, OpusEncoder>()
  const streams = new Map<string, Readable>()
  const userNames = new Map<string, string>()
  // nickname handling
  let prevNick: string | null | undefined = undefined
  let meMember: any = undefined
  let restoreNicknameFn: (() => Promise<void>) | undefined = undefined
  try {
    meMember = channel.guild.members.me ?? undefined
    if (!meMember) {
      // best-effort fetch
      meMember = await channel.guild.members.fetch((channel as any).client?.user?.id).catch(() => undefined)
    }
    if (meMember) prevNick = meMember.nickname ?? null
    // set recording nickname
    try {
      const botName =
        (channel as any).client?.user?.username || (meMember && meMember.user && meMember.user.username) || 'bot'
      const recNick = `🔴 (Recording) ${botName}`
      if (meMember && typeof meMember.setNickname === 'function') {
        await meMember.setNickname(recNick, 'Recording started')
      }
    } catch (e) {
      debug('Failed to set recording nickname', String(e))
    }
    // prepare restore function to run later (after transcription completes)
    restoreNicknameFn = async () => {
      try {
        if (meMember && typeof meMember.setNickname === 'function') {
          // First try to restore the previous nickname exactly
          await meMember.setNickname(prevNick ?? null, 'Recording ended')
        }
      } catch (e) {
        debug('Failed to restore nickname (first attempt)', String(e))
      }
      // If restore failed or wasn't possible, aggressively remove the recording tag
      try {
        const botId = (channel as any).client?.user?.id
        let curMember = channel.guild.members.me ?? undefined
        if (!curMember && botId) {
          curMember = await channel.guild.members.fetch(botId).catch(() => undefined)
        }
        if (curMember && typeof curMember.setNickname === 'function') {
          const recMarker = '🔴 (Recording)'
          const curNick = curMember.nickname ?? (curMember.user && curMember.user.username) ?? ''
          // Remove common forms of the marker and trim whitespace
          const newNick = curNick.replace(recMarker, '').trim()
          if (newNick === '') {
            await curMember.setNickname(null, 'Remove recording tag')
          } else {
            await curMember.setNickname(newNick, 'Remove recording tag')
          }
        }
      } catch (e) {
        debug('Failed to explicitly remove recording tag', String(e))
      }
    }
  } catch {}

  // init connection context (recordingId, rate, channels) for the server
  try {
    ws.send(encode({ type: 'init', recordingId, rate: 48000, channels: 2, includeAudio }))
  } catch {}

  const onStart = (userId: string) => {
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual }
    })
    // try to fetch the member display name for nicer VTT speaker labels
    try {
      const member = channel.guild.members.cache.get(userId) ?? undefined
      if (member) {
        userNames.set(userId, member.displayName || member.user.username)
      } else {
        // try fetch
        channel.guild.members
          .fetch(userId)
          .then((m) => {
            userNames.set(userId, m.displayName || m.user.username)
          })
          .catch(() => {})
      }
    } catch {
      debug(`Failed to fetch member name for userId: ${userId}`)
    }
    const decoder = new OpusEncoder(48000, 2)
    decoders.set(userId, decoder)
    streams.set(userId, opusStream as unknown as Readable)
    opusStream
      .on('data', (opusPacket: Buffer) => {
        try {
          const out = decoder.decode(opusPacket)
          const pcm = Buffer.isBuffer(out) ? out : Buffer.from((out as any).buffer)
          if (ws.readyState === ws.OPEN) {
            ws.send(
              encode({
                type: 'audio',
                recordingId,
                userId,
                userName: userNames.get(userId) || undefined,
                payload: pcm,
                encoding: 's16le',
                rate: 48000,
                channels: 2
              })
            )
          }
        } catch {}
      })
      .on('error', () => {})
  }

  receiver.speaking.on('start', onStart)

  const onEnd = (userId: string) => {
    const d = decoders.get(userId)
    if (d) decoders.delete(userId)
    const s = streams.get(userId)
    if (s) {
      try {
        // explicitly end/destroy manual streams
        if (typeof s.destroy === 'function') s.destroy()
        else if (typeof s.push === 'function') s.push(null)
      } catch {}
      streams.delete(userId)
    }
  }
  receiver.speaking.on('end', onEnd)

  const cleanup = async () => {
    try {
      receiver.speaking.removeListener('start', onStart)
      receiver.speaking.removeListener('end', onEnd)
    } catch {}
    try {
      ws.readyState === ws.OPEN && ws.send(encode({ type: 'stop', recordingId }))
    } catch {}
    // destroy any remaining user streams
    try {
      for (const [uid, s] of streams.entries()) {
        try {
          if (typeof s.destroy === 'function') s.destroy()
          else if (typeof s.push === 'function') s.push(null)
        } catch {}
        streams.delete(uid)
      }
      decoders.clear()
    } catch {}
    try {
      const existing = getVoiceConnection(channel.guild.id)
      existing?.destroy()
    } catch {}
  }

  const sess: RecSession = {
    recordingId,
    guildId: channel.guild.id,
    channelId: channel.id,
    textChannelId,
    ws,
    cleanup,
    done,
    restoreNickname: restoreNicknameFn,
    includeAudio
  }
  
  // Final check if we were cancelled
  const current = sessions.get(guildId)
  if (!current || (current.recordingId === 'pending' && current.cancelled)) {
    // We were cancelled
    await cleanup()
    ws.close()
    sessions.delete(guildId)
    throw new Error('Recording cancelled')
  }

  sessions.set(guildId, sess)
  return sess
  } catch (err) {
    if (sessions.get(guildId)?.recordingId === 'pending') {
      sessions.delete(guildId)
    }
    throw err
  }
}

export async function stopRecording(guildId: string) {
  const sess = sessions.get(guildId)
  if (!sess) throw new Error('No active recording')
  
  if (sess.recordingId === 'pending') {
    sess.cancelled = true
    sessions.delete(guildId)
    // Return a session-like object but with empty result fields.
    // Spreading sess preserves textChannelId and other context.
    return { ...sess, recordingId: '', vttPath: '' }
  }

  await sess.cleanup()
  const result = await sess.done
  try {
    if (typeof sess.restoreNickname === 'function') {
      await sess.restoreNickname()
    }
  } catch (e) {
    debug('restoreNickname failed', e)
  }
  try {
    sess.ws?.close()
  } catch {}
  sessions.delete(guildId)
  return { ...sess, ...result }
}

export function getActiveRecording(guildId: string) {
  return sessions.get(guildId)
}
