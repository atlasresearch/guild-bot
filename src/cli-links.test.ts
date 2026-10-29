// `guildbot links` tests: history pagination, place/thread discovery, access
// refusals, and the end-to-end command against a fake discord.js client.

import fsp from 'node:fs/promises'
import path from 'node:path'
import { ChannelType } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { TEST_GUILD_DIR, fake } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-links-'))
  return {
    TEST_GUILD_DIR: dir as string,
    fake: { guild: undefined as unknown, fetchedId: '', destroyed: 0, token: '' }
  }
})

vi.mock('@guildbot/guild-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/guild-config')>()
  return {
    ...actual,
    paths: (guildDir?: string) => actual.paths(guildDir ?? TEST_GUILD_DIR),
    loadConfig: () =>
      ({
        guild: { id: 'discord:100000000000000001', name: 'links' },
        discord: { token: 'fake-token' }
      }) as any
  }
})

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>()
  const { EventEmitter } = require('node:events') as typeof import('node:events')
  class Client extends EventEmitter {
    guilds = {
      fetch: async (id: string) => {
        fake.fetchedId = id
        return fake.guild
      }
    }
    constructor(public options: unknown) {
      super()
    }
    async login(token: string) {
      fake.token = token
      setImmediate(() => this.emit(actual.Events.ClientReady, this))
      return token
    }
    async destroy() {
      fake.destroyed++
    }
  }
  return { ...actual, Client }
})

import {
  accessRefusal,
  cmdLinks,
  defaultLinksPath,
  discordGuildId,
  discoverPlaces,
  fetchHistory,
  formatSummary,
  scanGuild,
  type GuildLike,
  type HistoryMessage,
  type SkippedPlace
} from './cli-links'

// ── fakes ───────────────────────────────────────────────────────────────────

let nextId = 1000n
function msg(content: string, extra: Partial<HistoryMessage> = {}): HistoryMessage {
  const id = String(500000000000000000n + nextId++)
  return {
    id,
    content,
    createdTimestamp: Date.parse('2024-01-01T00:00:00.000Z') + Number(nextId) * 1000,
    author: { id: '900000000000000001', username: 'alice' },
    embeds: [],
    attachments: [],
    ...extra
  }
}

function discordError(code: number) {
  return Object.assign(new Error(code === 50001 ? 'Missing Access' : 'Missing Permissions'), { code })
}

/** A channel whose history is `messages` (oldest first), served newest first like Discord. */
function fakeChannel(id: string, name: string, messages: HistoryMessage[], type = ChannelType.GuildText) {
  const calls: { limit: number; before?: string }[] = []
  const channel = {
    id,
    name,
    type,
    calls,
    messages: {
      fetch: async (opts: { limit: number; before?: string }) => {
        calls.push({ limit: opts.limit, before: opts.before })
        const older = opts.before ? messages.filter((m) => BigInt(m.id) < BigInt(opts.before!)) : messages
        const page = older.slice(-opts.limit).reverse()
        return new Map(page.map((m) => [m.id, m]))
      }
    }
  }
  return channel
}

function refusingChannel(id: string, name: string, code: number, type = ChannelType.GuildText) {
  return {
    id,
    name,
    type,
    messages: {
      fetch: async () => {
        throw discordError(code)
      }
    }
  }
}

function fakeThread(id: string, name: string, parentName: string, archivedAt: number | null, messages: HistoryMessage[]) {
  return { ...fakeChannel(id, name, messages, ChannelType.PublicThread), archiveTimestamp: archivedAt, parent: { name: parentName } }
}

type ArchivedPages = Partial<Record<'public' | 'private', ReturnType<typeof fakeThread>[][] | Error>>

function withThreads<T extends object>(channel: T, archived: ArchivedPages) {
  const calls: { type: string; before?: number; limit: number; fetchAll: boolean }[] = []
  return Object.assign(channel, {
    archivedCalls: calls,
    threads: {
      fetchArchived: async (opts: { type: 'public' | 'private'; before?: number; limit: number; fetchAll: boolean }) => {
        calls.push({ type: opts.type, before: opts.before, limit: opts.limit, fetchAll: opts.fetchAll })
        const pages = archived[opts.type] ?? []
        if (pages instanceof Error) throw pages
        const index = calls.filter((c) => c.type === opts.type).length - 1
        const page = pages[index] ?? []
        return { threads: new Map(page.map((t) => [t.id, t])), hasMore: index < pages.length - 1 }
      }
    }
  })
}

function fakeGuild(channels: object[], active: ReturnType<typeof fakeThread>[] = []): GuildLike {
  return {
    id: '100000000000000001',
    name: 'Test Guild',
    channels: {
      fetch: async () => new Map([...channels.map((c: any) => [c.id, c] as const), ['999', null]]),
      fetchActiveThreads: async () => ({ threads: new Map(active.map((t) => [t.id, t])) })
    }
  } as unknown as GuildLike
}

async function collect(channel: Parameters<typeof fetchHistory>[0]) {
  const pages: HistoryMessage[][] = []
  for await (const page of fetchHistory(channel)) pages.push(page)
  return pages
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('fetchHistory', () => {
  it('walks every page newest to oldest and stops at the first empty page', async () => {
    const history = Array.from({ length: 250 }, (_, i) => msg(`m${i}`))
    const channel = fakeChannel('200000000000000001', 'general', history)
    const pages = await collect(channel as any)

    expect(pages.map((p) => p.length)).toEqual([100, 100, 50])
    expect(pages.flat().map((m) => m.id)).toEqual(history.map((m) => m.id).reverse())
    expect(channel.calls).toEqual([
      { limit: 100, before: undefined },
      { limit: 100, before: history[150].id },
      { limit: 100, before: history[50].id },
      { limit: 100, before: history[0].id }
    ])
  })

  it('follows the oldest id even when a page is not ordered newest first', async () => {
    const [a, b, c] = [msg('a'), msg('b'), msg('c')]
    const pages = [new Map([[b.id, b], [a.id, a], [c.id, c]]), new Map()]
    const befores: (string | undefined)[] = []
    const channel = {
      id: '1',
      name: 'x',
      messages: { fetch: async (o: { before?: string }) => (befores.push(o.before), pages.shift()!) }
    }
    const got = await collect(channel as any)
    expect(got).toHaveLength(1)
    expect(befores).toEqual([undefined, a.id])
  })

  it('yields nothing for an empty channel', async () => {
    const channel = fakeChannel('1', 'empty', [])
    expect(await collect(channel as any)).toEqual([])
    expect(channel.calls).toHaveLength(1)
  })
})

describe('accessRefusal', () => {
  it('recognises 50001 and 50013 only', () => {
    expect(accessRefusal(discordError(50001))).toBe('50001 Missing Access')
    expect(accessRefusal(discordError(50013))).toBe('50013 Missing Permissions')
    expect(accessRefusal(Object.assign(new Error('Unknown Channel'), { code: 10003 }))).toBeUndefined()
    expect(accessRefusal(new Error('boom'))).toBeUndefined()
    expect(accessRefusal(undefined)).toBeUndefined()
  })
})

describe('discoverPlaces', () => {
  it('finds text-based channels plus active, archived public and archived private threads', async () => {
    const text = withThreads(fakeChannel('11', 'general', []), {
      public: [
        [fakeThread('t-pub-1', 'pub one', 'general', 3000, []), fakeThread('t-pub-2', 'pub two', 'general', 2000, [])],
        [fakeThread('t-pub-3', 'pub three', 'general', 1000, [])]
      ],
      private: [[fakeThread('t-priv-1', 'secret', 'general', 5000, [])]]
    })
    const news = withThreads(fakeChannel('12', 'news', [], ChannelType.GuildAnnouncement), {
      public: [[fakeThread('t-news', 'news thread', 'news', 100, [])]]
    })
    const voice = fakeChannel('13', 'voice', [], ChannelType.GuildVoice)
    const stage = fakeChannel('14', 'stage', [], ChannelType.GuildStageVoice)
    const forum = withThreads(
      { id: '15', name: 'forum', type: ChannelType.GuildForum },
      { public: [[fakeThread('t-post', 'a post', 'forum', 100, [])]] }
    )
    const media = withThreads(
      { id: '16', name: 'media', type: ChannelType.GuildMedia },
      { public: [[fakeThread('t-media', 'a media post', 'media', 100, [])]] }
    )
    const category = { id: '17', name: 'Category', type: ChannelType.GuildCategory }
    const active = [fakeThread('t-active', 'live', 'general', null, []), fakeThread('t-pub-1', 'pub one', 'general', 3000, [])]

    const skipped: SkippedPlace[] = []
    const places = await discoverPlaces(fakeGuild([text, news, voice, stage, forum, media, category], active), skipped)

    expect(skipped).toEqual([])
    expect(places.map((p) => p.source.id)).toEqual([
      '11',
      '12',
      '13',
      '14',
      't-active',
      't-pub-1',
      't-pub-2',
      't-pub-3',
      't-priv-1',
      't-news',
      't-post',
      't-media'
    ])
    expect(places.find((p) => p.source.id === 't-priv-1')).toMatchObject({
      label: '#general › secret',
      parentChannelName: 'general'
    })
    expect(places.find((p) => p.source.id === '11')).toMatchObject({ label: '#general', parentChannelName: '' })

    // Archived listings paginate by the oldest archive timestamp until hasMore is false.
    expect(text.archivedCalls).toEqual([
      { type: 'public', before: undefined, limit: 100, fetchAll: true },
      { type: 'public', before: 2000, limit: 100, fetchAll: true },
      { type: 'private', before: undefined, limit: 100, fetchAll: true }
    ])
    // Private threads exist only under text channels.
    expect(news.archivedCalls.map((c) => c.type)).toEqual(['public'])
    expect(forum.archivedCalls.map((c) => c.type)).toEqual(['public'])
  })

  it('records a refused archived listing and keeps going', async () => {
    const locked = withThreads(fakeChannel('11', 'locked', []), {
      public: [[fakeThread('t-a', 'a', 'locked', 10, [])]],
      private: discordError(50013)
    })
    const after = withThreads(fakeChannel('12', 'after', []), { public: [[fakeThread('t-b', 'b', 'after', 10, [])]] })
    const skipped: SkippedPlace[] = []
    const places = await discoverPlaces(fakeGuild([locked, after]), skipped)

    expect(skipped).toEqual([{ label: '#locked (archived private threads)', reason: '50013 Missing Permissions' }])
    expect(places.map((p) => p.source.id)).toEqual(['11', '12', 't-a', 't-b'])
  })

  it('rethrows errors that are not access refusals', async () => {
    const broken = withThreads(fakeChannel('11', 'broken', []), { public: new Error('socket hang up') })
    await expect(discoverPlaces(fakeGuild([broken]), [])).rejects.toThrow('socket hang up')
  })
})

describe('scanGuild', () => {
  it('scans every place, extracts link rows and skips refused places', async () => {
    const first = msg('start https://a.example and <https://b.example>', {
      embeds: [{ url: 'https://a.example' }],
      attachments: [{ url: 'https://cdn.example/f.png' }]
    })
    const plain = msg('no links')
    const inThread = msg('[docs](https://docs.example/x).')
    const general = withThreads(fakeChannel('200000000000000011', 'general', [first, plain]), {
      public: [[fakeThread('200000000000000099', 'help', 'general', 10, [inThread])]]
    })
    const hidden = refusingChannel('200000000000000012', 'mods', 50001)
    const noPerms = refusingChannel('200000000000000013', 'logs', 50013, ChannelType.GuildAnnouncement)
    const last = fakeChannel('200000000000000014', 'random', [msg('https://z.example')])

    const progress: string[] = []
    const result = await scanGuild(fakeGuild([general, hidden, noPerms, last]), {
      onProgress: (place, n, total) => progress.push(`${place.label}:${n}:${total}`)
    })

    expect(result.placesScanned).toBe(3)
    expect(result.messagesScanned).toBe(4)
    expect(result.skipped).toEqual([
      { label: '#mods', reason: '50001 Missing Access' },
      { label: '#logs', reason: '50013 Missing Permissions' }
    ])
    expect(result.rows.map((r) => [r.url, r.kind, r.channelName, r.parentChannelName])).toEqual([
      ['https://a.example', 'content', 'general', ''],
      ['https://b.example', 'content', 'general', ''],
      ['https://cdn.example/f.png', 'attachment', 'general', ''],
      ['https://z.example', 'content', 'random', ''],
      ['https://docs.example/x', 'content', 'help', 'general']
    ])
    const threadRow = result.rows.find((r) => r.url === 'https://docs.example/x')!
    expect(threadRow).toEqual({
      url: 'https://docs.example/x',
      kind: 'content',
      guildId: '100000000000000001',
      channelId: '200000000000000099',
      channelName: 'help',
      parentChannelName: 'general',
      messageId: inThread.id,
      messageUrl: `https://discord.com/channels/100000000000000001/200000000000000099/${inThread.id}`,
      authorId: '900000000000000001',
      authorName: 'alice',
      timestamp: new Date(inThread.createdTimestamp).toISOString()
    })
    expect(progress).toContain('#general:2:2')
    expect(progress).toContain('#general › help:1:4')
  })

  it('records a place that refuses mid-history with how far it got', async () => {
    const page = [msg('https://kept.example')]
    let calls = 0
    const flaky = {
      id: '1',
      name: 'flaky',
      type: ChannelType.GuildText,
      messages: {
        fetch: async () => {
          if (calls++ === 0) return new Map(page.map((m) => [m.id, m]))
          throw discordError(50001)
        }
      }
    }
    const result = await scanGuild(fakeGuild([flaky]))
    expect(result.placesScanned).toBe(0)
    expect(result.skipped).toEqual([{ label: '#flaky', reason: '50001 Missing Access (after 1 messages)' }])
    expect(result.rows.map((r) => r.url)).toEqual(['https://kept.example'])
  })
})

describe('helpers', () => {
  it('parses the numeric guild id from the config', () => {
    expect(discordGuildId('discord:100000000000000001')).toBe('100000000000000001')
    expect(() => discordGuildId('discord:not-a-number')).toThrow(/discord:<snowflake>/)
  })

  it('defaults to exports/links-<date>.csv', () => {
    expect(defaultLinksPath('/g/exports', new Date('2026-10-29T15:00:00Z'))).toBe('/g/exports/links-2026-10-29.csv')
  })

  it('summarises counts, skips and the output path', () => {
    const summary = formatSummary(
      {
        placesScanned: 3,
        skipped: [{ label: '#mods', reason: '50001 Missing Access' }],
        messagesScanned: 42,
        rows: [{ url: 'https://a' }, { url: 'https://a' }, { url: 'https://b' }] as any
      },
      '/out/links.csv'
    )
    expect(summary).toContain('Places scanned:   3')
    expect(summary).toContain('Places skipped:   1')
    expect(summary).toContain('  - #mods: 50001 Missing Access')
    expect(summary).toContain('Messages scanned: 42')
    expect(summary).toContain('Link occurrences: 3')
    expect(summary).toContain('Unique URLs:      2')
    expect(summary).toContain('Output:           /out/links.csv')
  })
})

describe('guildbot links command', () => {
  let stderr: string[]
  let origWrite: typeof process.stderr.write
  const exportsDir = path.join(TEST_GUILD_DIR, 'exports')

  beforeEach(async () => {
    fake.destroyed = 0
    fake.fetchedId = ''
    fake.token = ''
    stderr = []
    origWrite = process.stderr.write
    process.stderr.write = ((s: string) => (stderr.push(String(s)), true)) as any
    await fsp.rm(exportsDir, { recursive: true, force: true })
  })
  afterEach(async () => {
    process.stderr.write = origWrite
    await fsp.rm(exportsDir, { recursive: true, force: true })
  })

  it('writes the default CSV under the guild exports dir and destroys the client', async () => {
    const older = msg('first https://one.example')
    const newer = msg('then https://two.example')
    fake.guild = fakeGuild([fakeChannel('200000000000000011', 'general, "main"', [older, newer])])

    await cmdLinks([])

    expect(fake.token).toBe('fake-token')
    expect(fake.fetchedId).toBe('100000000000000001')
    expect(fake.destroyed).toBe(1)
    const files = await fsp.readdir(exportsDir)
    expect(files).toEqual([`links-${new Date().toISOString().slice(0, 10)}.csv`])
    const csv = await fsp.readFile(path.join(exportsDir, files[0]), 'utf8')
    const lines = csv.trimEnd().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[1].startsWith('https://one.example,content,100000000000000001,200000000000000011,"general, ""main""",')).toBe(true)
    expect(lines[2].startsWith('https://two.example,')).toBe(true)
    const out = stderr.join('')
    expect(out).toContain('#general, "main"')
    expect(out).toContain('Link occurrences: 2')
    expect(out).toContain(`Output:           ${path.join(exportsDir, files[0])}`)
  })

  it('writes JSON when --out ends in .json', async () => {
    fake.guild = fakeGuild([fakeChannel('200000000000000011', 'general', [msg('https://one.example')])])
    const out = path.join(exportsDir, 'custom', 'all.json')
    await cmdLinks(['--out', out])
    const rows = JSON.parse(await fsp.readFile(out, 'utf8'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ url: 'https://one.example', kind: 'content', channelName: 'general' })
  })

  it('destroys the client when the scan fails', async () => {
    fake.guild = fakeGuild([withThreads(fakeChannel('1', 'x', []), { public: new Error('gateway down') })])
    await expect(cmdLinks([])).rejects.toThrow('gateway down')
    expect(fake.destroyed).toBe(1)
  })
})
