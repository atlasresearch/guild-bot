import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths } from './paths'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CODEBASE_ROOT = resolve(HERE, '..', '..')

export type SyncOptions = {
  force?: boolean
  codebaseRoot?: string
}

/**
 * Re-copy `tools/` and `skills/` from the codebase into the guild dir.
 *
 * - With `force=false` (default), seed only if the target dir is missing.
 * - With `force=true`, overwrite operator customisations.
 *
 * MUST NOT touch config.json, secrets.json, prompt.md, memory.md, or any data
 * directory (R5.5 from plan 003 + R6.3 from plan 006).
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
    if (opts.force || !existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true })
      if (opts.force && existsSync(dest)) {
        rmSync(dest, { recursive: true, force: true })
      }
      cpSync(src, dest, { recursive: true })
    }
  }
}
