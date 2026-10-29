// `guildbot links` — export every link ever posted in the guild.
//
// Examples:
//   guildbot links
//   guildbot links --guild-dir ~/.guildbot/myguild --out links.json
//
// Walks every text-based channel (text, announcement, voice/stage chat) and
// every active + archived thread under text, announcement, forum and media
// channels, paging through the full message history of each. Places the bot
// cannot read (Discord 50001 / 50013) are skipped and reported.

import { once } from 'node:events'
import path from 'node:path'
import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js'
import { extractLinks, writeLinks, type LinkRow, type LinkSource } from '@guildbot/exporters'
import { loadConfig, paths } from '@guildbot/guild-config'

type Argv = string[]

// ── structural Discord shapes (satisfied by discord.js, and by test fakes) ───

export interface HistoryMessage extends LinkSource {
  id: string
  createdTimestamp: number
  author: { id: string; username: string }
}

interface Page<T> {
  size: number
  values(): IterableIterator<T>
}

export interface MessageSource {
  id: string
  name: string
  messages: {
    fetch(options: { limit: number; before?: string; cache: boolean }): Promise<Page<HistoryMessage>>
  }
}

export interface ThreadLike extends MessageSource {
  archiveTimestamp: number | null
  parent: { name: string } | null
}

interface ArchivedOptions {
  type: 'public' | 'private'
  fetchAll: boolean
  before?: number
  limit: number
}

export interface ChannelLike extends Partial<MessageSource> {
  id: string
  name: string
  type: ChannelType
  threads?: {
    fetchArchived(options: ArchivedOptions): Promise<{ threads: Page<ThreadLike>; hasMore: boolean }>
  }
}

export interface GuildLike {
  id: string
  name: string
  channels: {
    fetch(): Promise<Page<ChannelLike | null>>
    fetchActiveThreads(): Promise<{ threads: Page<ThreadLike> }>
  }
}

export interface Place {
  source: MessageSource
  label: string
  parentChannelName: string
}

export interface SkippedPlace {
  label: string
  reason: string
}

export interface ScanResult {
  rows: LinkRow[]
  placesScanned: number
  skipped: SkippedPlace[]
  messagesScanned: number
}

const MESSAGE_CHANNEL_TYPES = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice
])
const THREAD_PARENT_TYPES = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia
])
// Private threads only exist under plain text channels.
const PRIVATE_THREAD_PARENT_TYPES = new Set<ChannelType>([ChannelType.GuildText])

const ACCESS_REFUSAL_CODES = new Set([50001, 50013])

/** Discord "Missing Access" (50001) or "Missing Permissions" (50013). */
export function accessRefusal(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code
  if (typeof code !== 'number' || !ACCESS_REFUSAL_CODES.has(code)) return undefined
  return `${code} ${(err as Error).message ?? ''}`.trim()
}

function oldestSnowflake(ids: Iterable<string>): string | undefined {
  let oldest: string | undefined
  for (const id of ids) {
    if (oldest === undefined || BigInt(id) < BigInt(oldest)) oldest = id
  }
  return oldest
}

/** Pages of a channel's history, newest first, until Discord returns an empty page. */
export async function* fetchHistory(source: MessageSource): AsyncGenerator<HistoryMessage[]> {
  let before: string | undefined
  for (;;) {
    const page = await source.messages.fetch({ limit: 100, before, cache: false })
    if (page.size === 0) return
    const messages = [...page.values()]
    yield messages
    before = oldestSnowflake(messages.map((m) => m.id))
  }
}

async function fetchArchivedThreads(channel: ChannelLike, type: 'public' | 'private'): Promise<ThreadLike[]> {
  const out: ThreadLike[] = []
  let before: number | undefined
  for (;;) {
    const res = await channel.threads!.fetchArchived({ type, fetchAll: true, before, limit: 100 })
    const threads = [...res.threads.values()]
    out.push(...threads)
    const stamps = threads.map((t) => t.archiveTimestamp).filter((s): s is number => typeof s === 'number')
    if (!res.hasMore || stamps.length === 0) return out
    before = Math.min(...stamps)
  }
}

/**
 * Every message-bearing place in the guild: text-based channels, then active
 * and archived (public + private) threads. Listings Discord refuses are recorded in `skipped`.
 */
export async function discoverPlaces(guild: GuildLike, skipped: SkippedPlace[]): Promise<Place[]> {
  const channels = [...(await guild.channels.fetch()).values()].filter((c): c is ChannelLike => c !== null)
  const places: Place[] = []
  for (const c of channels) {
    if (MESSAGE_CHANNEL_TYPES.has(c.type) && c.messages) {
      places.push({ source: c as MessageSource, label: `#${c.name}`, parentChannelName: '' })
    }
  }

  const threads = new Map<string, ThreadLike>()
  const addThreads = (list: Iterable<ThreadLike>) => {
    for (const t of list) if (!threads.has(t.id)) threads.set(t.id, t)
  }

  const attempt = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      const reason = accessRefusal(err)
      if (!reason) throw err
      skipped.push({ label, reason })
    }
  }

  await attempt('active threads', async () => addThreads((await guild.channels.fetchActiveThreads()).threads.values()))
  for (const c of channels) {
    if (!THREAD_PARENT_TYPES.has(c.type) || !c.threads) continue
    await attempt(`#${c.name} (archived public threads)`, async () =>
      addThreads(await fetchArchivedThreads(c, 'public'))
    )
    if (PRIVATE_THREAD_PARENT_TYPES.has(c.type)) {
      await attempt(`#${c.name} (archived private threads)`, async () =>
        addThreads(await fetchArchivedThreads(c, 'private'))
      )
    }
  }

  for (const t of threads.values()) {
    const parent = t.parent?.name ?? ''
    places.push({ source: t, label: parent ? `#${parent} › ${t.name}` : t.name, parentChannelName: parent })
  }
  return places
}

export function messageToRows(guildId: string, place: Place, message: HistoryMessage): LinkRow[] {
  const channelId = place.source.id
  return extractLinks(message).map((link) => ({
    url: link.url,
    kind: link.kind,
    guildId,
    channelId,
    channelName: place.source.name,
    parentChannelName: place.parentChannelName,
    messageId: message.id,
    messageUrl: `https://discord.com/channels/${guildId}/${channelId}/${message.id}`,
    authorId: message.author.id,
    authorName: message.author.username,
    timestamp: new Date(message.createdTimestamp).toISOString()
  }))
}

export interface ScanOptions {
  onProgress?: (place: Place, placeMessages: number, totalMessages: number) => void
}

/** Walk the full history of every place in the guild and collect link rows. */
export async function scanGuild(guild: GuildLike, opts: ScanOptions = {}): Promise<ScanResult> {
  const skipped: SkippedPlace[] = []
  const places = await discoverPlaces(guild, skipped)
  const rows: LinkRow[] = []
  let placesScanned = 0
  let messagesScanned = 0

  for (const place of places) {
    let placeMessages = 0
    opts.onProgress?.(place, 0, messagesScanned)
    try {
      for await (const page of fetchHistory(place.source)) {
        for (const message of page) rows.push(...messageToRows(guild.id, place, message))
        placeMessages += page.length
        messagesScanned += page.length
        opts.onProgress?.(place, placeMessages, messagesScanned)
      }
      placesScanned++
    } catch (err) {
      const reason = accessRefusal(err)
      if (!reason) throw err
      skipped.push({
        label: place.label,
        reason: placeMessages ? `${reason} (after ${placeMessages} messages)` : reason
      })
    }
  }
  return { rows, placesScanned, skipped, messagesScanned }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function getFlag(argv: Argv, name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = argv[i + 1]
  if (!v) throw new Error(`--${name} requires a value`)
  return v
}

function applyGuildDirFlag(argv: Argv): Argv {
  const i = argv.indexOf('--guild-dir')
  if (i < 0) return argv
  const v = argv[i + 1]
  if (!v) throw new Error('--guild-dir requires a value')
  process.env.GUILDBOT_GUILD_DIR = v
  return [...argv.slice(0, i), ...argv.slice(i + 2)]
}

/** `discord:<snowflake>` → `<snowflake>`. */
export function discordGuildId(configGuildId: string): string {
  const id = configGuildId.replace(/^discord:/, '')
  if (!/^\d{17,20}$/.test(id)) throw new Error(`guild.id must be discord:<snowflake>, got ${configGuildId}`)
  return id
}

export function defaultLinksPath(exportsDir: string, now: Date = new Date()): string {
  return path.join(exportsDir, `links-${now.toISOString().slice(0, 10)}.csv`)
}

export function formatSummary(result: ScanResult, outPath: string): string {
  const unique = new Set(result.rows.map((r) => r.url)).size
  const lines = [
    `Places scanned:   ${result.placesScanned}`,
    `Places skipped:   ${result.skipped.length}`,
    ...result.skipped.map((s) => `  - ${s.label}: ${s.reason}`),
    `Messages scanned: ${result.messagesScanned}`,
    `Link occurrences: ${result.rows.length}`,
    `Unique URLs:      ${unique}`,
    `Output:           ${outPath}`
  ]
  return lines.join('\n')
}

function stderrProgress(): ScanOptions['onProgress'] {
  const tty = process.stderr.isTTY
  let current: Place | undefined
  return (place, placeMessages, totalMessages) => {
    const line = `${place.label}: ${placeMessages} messages (total ${totalMessages})`
    if (tty) {
      if (current && current !== place) process.stderr.write('\n')
      process.stderr.write(`\r\x1b[K${line}`)
    } else if (current !== place || (placeMessages > 0 && placeMessages % 1000 === 0)) {
      process.stderr.write(`${line}\n`)
    }
    current = place
  }
}

export async function cmdLinks(rawArgv: Argv) {
  const argv = applyGuildDirFlag(rawArgv)
  const out = getFlag(argv, 'out')
  const config = loadConfig()
  const token = config.discord.token
  if (!token) throw new Error('Missing discord.token in guild config (secrets.json)')
  const guildId = discordGuildId(config.guild.id)
  const outPath = path.resolve(out ?? defaultLinksPath(paths().exports))

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  })
  try {
    const ready = once(client, Events.ClientReady)
    ready.catch(() => undefined) // login failure surfaces from login() itself
    await client.login(token)
    await ready
    const guild = await client.guilds.fetch(guildId)
    process.stderr.write(`Exporting links from ${guild.name} (${guild.id})\n`)
    // discord.js's overloaded managers don't unify with the structural GuildLike; they satisfy it at runtime.
    const result = await scanGuild(guild as unknown as GuildLike, { onProgress: stderrProgress() })
    if (process.stderr.isTTY) process.stderr.write('\n')
    await writeLinks(result.rows, outPath)
    process.stderr.write(formatSummary(result, outPath) + '\n')
  } finally {
    await client.destroy()
  }
}
