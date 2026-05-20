import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths } from './paths'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CODEBASE_ROOT = resolve(HERE, '..', '..')

export type SyncOptions = {
  /** When true, wipe each target dir before copying — removes orphans. */
  force?: boolean
  codebaseRoot?: string
}

/**
 * Re-copy `tools/` and `skills/` from the codebase into the guild dir.
 *
 * - Default (force=false): cpSync overwrites matching files and leaves any
 *   operator-added orphans alone. This is the same behaviour as the on-startup
 *   resync in initGuildDir.
 * - force=true: removes each target dir first, then copies. Orphans (including
 *   operator customisations) are deleted. Use for a clean re-seed.
 *
 * Never touches config.json, secrets.json, prompt.md, memory.md, or any data
 * directory.
 */
export function syncFromCodebase(guildDir: string, opts: SyncOptions = {}): void {
  const codebaseRoot = opts.codebaseRoot ?? DEFAULT_CODEBASE_ROOT
  const p = paths(resolve(guildDir))

  const tasks: Array<{ src: string; dest: string }> = [
    { src: join(codebaseRoot, 'tools'), dest: p.tools },
    { src: join(codebaseRoot, 'skills'), dest: p.skills },
  ]

  for (const { src, dest } of tasks) {
    if (!existsSync(src)) continue
    mkdirSync(dirname(dest), { recursive: true })
    if (opts.force && existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true })
    }
    cpSync(src, dest, { recursive: true })
  }
}
