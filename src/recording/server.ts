import { decode } from 'msgpackr'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { ensureWhisperAvailable, transcribeWithWhisper } from '../interfaces/whisper'

type UserState = {
  buf: Buffer
  elapsedSec: number
  chunkIndex: number
  wavPath: string
  bytes: number
  stream: fs.WriteStream | null
  samplesWritten: number
  userName?: string
}
type QueueItem = { userId: string; buf: Buffer }

type Session = {
  id: string
  rate: number
  channels: number
  bytesPerSec: number
  bytesPerChunk: number
  dir: string
  vttPath: string
  includeAudio: boolean
  users: Map<string, UserState>
  queue: QueueItem[]
  processing: boolean
  closed: boolean
  startNs: bigint
  endNs?: bigint
}

const SESSIONS = new Map<string, Session>()
const SUBSCRIBERS = new Map<string, Set<WebSocket>>()
const SESSION_PREFS = new Map<string, { includeAudio: boolean }>()

function subscribe(recId: string, ws: WebSocket) {
  if (!SUBSCRIBERS.has(recId)) SUBSCRIBERS.set(recId, new Set())
  SUBSCRIBERS.get(recId)!.add(ws)
  ws.once('close', () => {
    try {
      const set = SUBSCRIBERS.get(recId)
      if (set) {
        set.delete(ws)
        if (set.size === 0) SUBSCRIBERS.delete(recId)
      }
    } catch {}
  })
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function makeWav(pcm: Buffer, rate: number, channels: number) {
  const bitsPerSample = 16
  const byteRate = (rate * channels * bitsPerSample) / 8
  const blockAlign = (channels * bitsPerSample) / 8
  const dataSize = pcm.length
  const fmtChunkSize = 16
  const riffChunkSize = 4 + (8 + fmtChunkSize) + (8 + dataSize)

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(riffChunkSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(fmtChunkSize, 16) // Subchunk1Size
  header.writeUInt16LE(1, 20) // AudioFormat PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcm])
}

function tsToSeconds(ts: string) {
  const m = ts.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/)
  if (!m) return 0
  const h = Number(m[1]),
    mnt = Number(m[2]),
    s = Number(m[3]),
    ms = Number(m[4])
  return h * 3600 + mnt * 60 + s + ms / 1000
}

function secondsToTs(sec: number) {
  const h = Math.floor(sec / 3600)
  const rem = sec - h * 3600
  const m = Math.floor(rem / 60)
  const s = Math.floor(rem - m * 60)
  const ms = Math.round((sec - Math.floor(sec)) * 1000)
  const pad = (n: number, w: number) => n.toString().padStart(w, '0')
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`
}

async function appendVttWithOffset(destPath: string, chunkPath: string, offsetSec: number, userName?: string) {
  const raw = await fsp.readFile(chunkPath, 'utf8')
  const lines = raw.split(/\r?\n/)
  const out: string[] = []
  let expectTextPrefix = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.includes('-->')) {
      const [a, b] = l.split('-->')
      const as = tsToSeconds(a.trim()) + offsetSec
      const bs = tsToSeconds(b.trim()) + offsetSec
      out.push(`${secondsToTs(as)} --> ${secondsToTs(bs)}`)
      // next non-empty line is the cue text; prefix once with speaker
      expectTextPrefix = true
    } else if (l.trim() === 'WEBVTT') {
      // skip header; we'll write our own on first write
    } else {
      if (expectTextPrefix && l.trim() !== '') {
        if (userName) {
          // prefix with <v Name> marker
          const safe = String(userName).replace(/<|>/g, '')
          out.push(`<v ${safe}> ${l}`)
        } else {
          out.push(l)
        }
        expectTextPrefix = false
      } else {
        out.push(l)
      }
      if (l.trim() === '') expectTextPrefix = false
    }
  }
  const exists = fs.existsSync(destPath)
  if (!exists) await fsp.writeFile(destPath, 'WEBVTT\n\n', 'utf8')
  await fsp.appendFile(destPath, out.join('\n') + '\n')
}

async function processChunk(sess: Session, userId: string, pcmChunk: Buffer) {
  const u = sess.users.get(userId)!
  // Use temporary files for Whisper input/output; do not litter recording folder
  const tmpDir = path.join(os.tmpdir(), 'discord-rec-chunks')
  ensureDir(tmpDir)
  const base = `${sess.id}-${userId}-${String(u.chunkIndex).padStart(4, '0')}`
  const wavTmp = path.join(tmpDir, `${base}.wav`)
  const vttTmp = path.join(tmpDir, `${base}.vtt`)

  const wav = makeWav(pcmChunk, sess.rate, sess.channels)
  await fsp.writeFile(wavTmp, wav)

  const outBase = vttTmp.replace(/\.vtt$/, '')
  const model = process.env.WHISPER_MODEL || path.join(os.homedir(), 'models/ggml-base.en.bin')
  await transcribeWithWhisper(model, wavTmp, vttTmp, outBase)
  await appendVttWithOffset(sess.vttPath, vttTmp, u.elapsedSec, u.userName)

  const secs = pcmChunk.length / sess.bytesPerSec
  u.elapsedSec += secs
  u.chunkIndex++

  try {
    await fsp.unlink(wavTmp)
  } catch {}
  try {
    await fsp.unlink(vttTmp)
  } catch {}
}

async function processQueue(sess: Session) {
  if (sess.processing) return
  sess.processing = true
  try {
    while (sess.queue.length > 0) {
      const item = sess.queue.shift() as QueueItem
      try {
        await processChunk(sess, item.userId, item.buf)
      } catch (e) {
        console.warn('[rec-server] chunk processing failed', e)
      }
    }
  } finally {
    sess.processing = false
    // If closed and no more queued data, finalize session removal
    if (sess.closed && sess.queue.length === 0) {
      // finalize per-user WAV: fill trailing silence, close stream and fix header sizes
      const nowNs = sess.endNs ?? process.hrtime.bigint()
      const elapsedNs = nowNs - sess.startNs
      const endSamples = Math.max(0, Math.floor((Number(elapsedNs) * sess.rate) / 1_000_000_000))
      for (const [, u] of sess.users) {
        if (sess.includeAudio) {
          try {
            // Fill trailing silence up to session end
            const frameBytes = sess.channels * 2
            const remainingSamples = endSamples - (u.samplesWritten || 0)
            if (remainingSamples > 0 && u.stream && !(u.stream as any).writableEnded) {
              const zero = Buffer.alloc(Math.min(remainingSamples * frameBytes, 1024 * 1024))
              let toWrite = remainingSamples * frameBytes
              while (toWrite > 0) {
                const n = Math.min(toWrite, zero.length)
                u.stream.write(zero.subarray(0, n))
                u.bytes += n
                toWrite -= n
              }
              u.samplesWritten += remainingSamples
            }
            if (u.stream) {
              await new Promise<void>((resolve) => {
                try {
                  u.stream!.end(() => resolve())
                } catch {
                  resolve()
                }
              })
            }
            try {
              const fh = await fsp.open(u.wavPath, 'r+')
              const dataSize = u.bytes
              const riffSize = 36 + dataSize
              const b1 = Buffer.alloc(4)
              b1.writeUInt32LE(riffSize, 0)
              await fh.write(b1, 0, 4, 4)
              const b2 = Buffer.alloc(4)
              b2.writeUInt32LE(dataSize, 0)
              await fh.write(b2, 0, 4, 40)
              await fh.close()
            } catch {}
          } catch {}
        } else {
          // No WAV persistence requested; nothing to finalize
        }
      }
      // clear user maps
      sess.users.clear()
      // notify subscribers of completion
      try {
        const subs = SUBSCRIBERS.get(sess.id)
        if (subs && subs.size) {
          const msg = Buffer.from(JSON.stringify({ type: 'done', recordingId: sess.id, vttPath: sess.vttPath }), 'utf8')
          for (const ws of subs) {
            try {
              ;(ws as any).readyState === (ws as any).OPEN && ws.send(msg)
            } catch {}
          }
        }
      } catch {}
      try {
        SUBSCRIBERS.delete(sess.id)
      } catch {}
      try {
        SESSION_PREFS.delete(sess.id)
      } catch {}
      // drop from session map
      try {
        SESSIONS.delete(sess.id)
      } catch {}
    }
  }
}

function takeBytes(buf: Buffer, count: number): { head: Buffer; tail: Buffer } {
  if (buf.length <= count) return { head: buf, tail: Buffer.alloc(0) }
  return { head: buf.subarray(0, count), tail: buf.subarray(count) }
}

async function handlePcm(recId: string, rate: number, channels: number, pcm: Buffer, userId: string) {
  let sess = SESSIONS.get(recId)
  if (!sess) {
    const dir = path.resolve(process.cwd(), '.tmp', 'recordings', recId)
    ensureDir(dir)
    const vttPath = path.join(dir, 'audio.vtt')
    const includeAudio = SESSION_PREFS.get(recId)?.includeAudio ?? false
    sess = {
      id: recId,
      rate,
      channels,
      bytesPerSec: rate * channels * 2,
      bytesPerChunk: rate * channels * 2 * 10,
      dir,
      vttPath,
      includeAudio,
      users: new Map<string, UserState>(),
      queue: [],
      processing: false,
      closed: false,
      startNs: process.hrtime.bigint()
    }
    SESSIONS.set(recId, sess)
  }

  const session = sess

  let u = session.users.get(userId)
  if (!u) {
    const wavPath = path.join(session.dir, `${userId}.wav`)
    const stream = session.includeAudio ? fs.createWriteStream(wavPath, { flags: 'w' }) : null
    if (stream) {
      const header = makeWav(Buffer.alloc(0), rate, channels)
      try {
        stream.write(header)
      } catch {}
    }
    u = {
      buf: Buffer.alloc(0),
      elapsedSec: 0,
      chunkIndex: 0,
      wavPath,
      bytes: 0,
      stream,
      samplesWritten: 0
    }
    session.users.set(userId, u)
  }
  // if caller supplied userName in future, caller should set u.userName

  // Append PCM to the continuous WAV stream
  try {
    if (session.includeAudio && u.stream && !(u.stream as any).writableEnded) {
      const frameBytes = channels * 2
      // Compute target sample position from wall-clock since session start
      const nowNs = process.hrtime.bigint()
      const elapsedNs = nowNs - session.startNs
      const targetSamples = Math.max(0, Math.floor((Number(elapsedNs) * rate) / 1_000_000_000))
      const gapSamples = targetSamples - (u.samplesWritten || 0)
      if (gapSamples > 0) {
        const zero = Buffer.alloc(Math.min(gapSamples * frameBytes, 1024 * 1024))
        let toWrite = gapSamples * frameBytes
        while (toWrite > 0) {
          const n = Math.min(toWrite, zero.length)
          u.stream.write(zero.subarray(0, n))
          u.bytes += n
          toWrite -= n
        }
        u.samplesWritten += gapSamples
      }
      u.stream.write(pcm)
      u.bytes += pcm.length
      u.samplesWritten += Math.floor(pcm.length / frameBytes)
    }
  } catch {}

  u.buf = Buffer.concat([u.buf, pcm])
  while (u.buf.length >= session.bytesPerChunk) {
    const { head, tail } = takeBytes(u.buf, session.bytesPerChunk)
    session.queue.push({ userId, buf: head })
    u.buf = tail
  }
  // kick queue processor asynchronously
  void processQueue(session)
}

async function handleAudioMessage(msg: any) {
  const recId = String(msg.recordingId || '')
  if (!recId) return
  const rate = Number(msg.rate || 48000)
  const channels = Number(msg.channels || 2)
  const userId: string = String(msg.userId || 'unknown')
  const pcm: Buffer = Buffer.isBuffer(msg.payload) ? msg.payload : Buffer.from(msg.payload)
  if (!pcm) return
  await handlePcm(recId, rate, channels, pcm, userId)
}

async function handleStop(recId: string) {
  const sess = SESSIONS.get(recId)
  if (!sess) {
    // If logic: handle empty session (silence only)
    try {
      const subs = SUBSCRIBERS.get(recId)
      if (subs && subs.size) {
        const msg = Buffer.from(JSON.stringify({ type: 'done', recordingId: recId, vttPath: null }), 'utf8')
        for (const ws of subs) {
          try {
            ;(ws as any).readyState === (ws as any).OPEN && ws.send(msg)
          } catch {}
        }
      }
    } catch {}
    try {
      SUBSCRIBERS.delete(recId)
    } catch {}
    try {
      SESSION_PREFS.delete(recId)
    } catch {}
    return
  }
  // mark end time for trailing silence fill
  sess.endNs = process.hrtime.bigint()
  // queue any tail (shorter than full chunk) for each user
  for (const [userId, u] of sess.users.entries()) {
    if (u.buf.length > 0) {
      sess.queue.push({ userId, buf: u.buf })
      u.buf = Buffer.alloc(0)
    }
  }
  // mark closed and ensure queue processing is running
  sess.closed = true
  void processQueue(sess)
}

const isDev = process.env.NODE_ENV !== 'production'

const defaultPort = isDev ? 8766 : 8765

export async function startTranscriptionServer(port = Number(process.env.AUDIO_WS_PORT) || defaultPort) {
  await ensureWhisperAvailable()
  const wss = new WebSocketServer({ port })
  console.log(`[rec-server] listening on ws://localhost:${port}`)

  wss.on('connection', (ws: WebSocket) => {
    // Track a simple per-connection context so binary frames can omit metadata
    const ctx: { recId?: string; rate: number; channels: number } = { rate: 48000, channels: 2 }

    ws.on('message', async (data: any) => {
      try {
        if (Buffer.isBuffer(data)) {
          // Try to decode as msgpack control message; if that fails, treat as raw PCM
          let msg: any = null
          try {
            msg = decode(data)
          } catch {
            msg = null
          }
          if (msg && typeof msg === 'object' && (msg.type || msg.payload)) {
            if (msg.type === 'init' || msg.type === 'hello') {
              if (msg.recordingId) ctx.recId = String(msg.recordingId)
              if (msg.rate) ctx.rate = Number(msg.rate)
              if (msg.channels) ctx.channels = Number(msg.channels)
              if (msg.recordingId) {
                SESSION_PREFS.set(String(msg.recordingId), { includeAudio: Boolean(msg.includeAudio) })
              }
              if (ctx.recId) subscribe(ctx.recId, ws)
              return
            }
            if (msg.type === 'stop' && msg.recordingId) {
              await handleStop(String(msg.recordingId))
              return
            }
            if (msg.payload || msg.type === 'audio') {
              if (msg.recordingId) ctx.recId = String(msg.recordingId)
              if (msg.rate) ctx.rate = Number(msg.rate)
              if (msg.channels) ctx.channels = Number(msg.channels)
              if (msg.userName) {
                // set userName in user state for VTT speaker labels
                const recId = String(msg.recordingId || '')
                const sess = SESSIONS.get(recId)
                if (sess) {
                  const userId: string = String(msg.userId || 'unknown')
                  let u = sess.users.get(userId)
                  if (u) {
                    u.userName = String(msg.userName)
                  }
                }
              }
              if (ctx.recId) subscribe(ctx.recId, ws)
              await handleAudioMessage(msg)
              return
            }
          }
          // Raw PCM path
          if (ctx.recId) {
            subscribe(ctx.recId, ws)
            await handlePcm(ctx.recId, ctx.rate, ctx.channels, data as Buffer, 'unknown')
          }
          return
        }
      } catch (e) {
        console.warn('[rec-server] message handling failed', e)
      }
    })
  })

  return wss
}

export type { Session }
