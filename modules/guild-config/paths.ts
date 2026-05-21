import { join } from 'node:path'
import { resolveGuildDir } from './resolveGuildDir'

export type GuildPaths = {
  root: string
  config: string
  secrets: string
  db: string
  recordings: string
  sessions: string
  contextDir: string
  media: string
  exports: string
  threads: string
  tools: string
  skills: string
  prompt: string
  memory: string
  memoryHistory: string
  snapshots: string
}

/**
 * All path constants formerly exposed by `@guildbot/config`, rooted at the
 * active guild dir (or an explicit override).
 */
export function paths(guildDir?: string): GuildPaths {
  const root = guildDir ?? resolveGuildDir()
  return {
    root,
    config: join(root, 'config.json'),
    secrets: join(root, 'secrets.json'),
    db: join(root, 'db'),
    recordings: join(root, 'recordings'),
    sessions: join(root, 'sessions'),
    contextDir: join(root, 'sessions', 'context'),
    media: join(root, 'media'),
    exports: join(root, 'exports'),
    threads: join(root, 'threads'),
    tools: join(root, 'tools'),
    skills: join(root, 'skills'),
    prompt: join(root, 'prompt.md'),
    memory: join(root, 'memory.md'),
    memoryHistory: join(root, 'memory-history'),
    snapshots: join(root, 'snapshots'),
  }
}

export const DATA_SUBDIRS = [
  'db',
  'recordings',
  'sessions',
  'sessions/context',
  'media',
  'exports',
  'threads',
  'memory-history',
  'snapshots',
] as const
