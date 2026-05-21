// Discord → guild-bot thread mapping. Per plan 005 R2: kept separate from
// @guildbot/threads so the threads module has zero Discord knowledge.
//
// Files live under <GUILD_DIR>/threads/index/discord/{thread,reply}/<id>.json
// alongside the thread store, so an operator inspecting a guild dir sees the
// bindings co-located with the threads they reference.

import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from '@guildbot/interfaces'
import { paths } from '@guildbot/guild-config'
import type { ThreadId } from '@guildbot/threads'

export type DiscordIndexKind = 'thread' | 'reply'

export type DiscordIndexEntry = {
  threadId: ThreadId
  boundAt: string
}

function indexFile(kind: DiscordIndexKind, key: string): string {
  return join(paths().threads, 'index', 'discord', kind, `${key}.json`)
}

export async function bindDiscord(opts: {
  kind: DiscordIndexKind
  key: string
  threadId: ThreadId
}): Promise<void> {
  const file = indexFile(opts.kind, opts.key)
  await fsp.mkdir(join(file, '..'), { recursive: true })
  const entry: DiscordIndexEntry = {
    threadId: opts.threadId,
    boundAt: new Date().toISOString(),
  }
  await atomicWrite(file, JSON.stringify(entry, null, 2) + '\n')
}

export async function resolveDiscord(opts: {
  kind: DiscordIndexKind
  key: string
}): Promise<ThreadId | undefined> {
  try {
    const raw = await fsp.readFile(indexFile(opts.kind, opts.key), 'utf8')
    const entry = JSON.parse(raw) as DiscordIndexEntry
    return entry.threadId
  } catch (e: any) {
    if (e?.code === 'ENOENT') return undefined
    throw e
  }
}

export async function unbindDiscord(opts: {
  kind: DiscordIndexKind
  key: string
}): Promise<void> {
  try {
    await fsp.unlink(indexFile(opts.kind, opts.key))
  } catch (e: any) {
    if (e?.code === 'ENOENT') return
    throw e
  }
}
