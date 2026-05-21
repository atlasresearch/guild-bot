import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 *   resync in initGuildDir. Never touches prompt.md or memory.md.
 * - force=true: removes each target dir first, then copies. Orphans (including
 *   operator customisations) are deleted. ALSO overwrites prompt.md and
 *   memory.md with the bundled defaults, moving the prior content into
 *   history/{prompt,memory}/ first.
 *
 * Never touches config.json, secrets.json, or any data directory.
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

  // R5.3: --force overwrites prompt.md / memory.md with the bundled defaults,
  // but only after archiving the prior content into history/. Without --force,
  // operator customisations are sacred and are left untouched.
  if (opts.force) {
    for (const kind of ['prompt', 'memory'] as const) {
      const src = join(codebaseRoot, 'guild-defaults', `${kind}.md`)
      if (!existsSync(src)) continue
      const dest = kind === 'prompt' ? p.prompt : p.memory
      const historyDir = kind === 'prompt' ? p.promptHistory : p.memoryHistory
      mkdirSync(historyDir, { recursive: true })
      if (existsSync(dest)) {
        try {
          const prior = readFileSync(dest, 'utf8')
          const ts = new Date()
            .toISOString()
            .replace(/[-:.]/g, '')
            .replace(/\..+/, 'Z')
          const histPath = join(historyDir, `${ts}-sync-force.md`)
          writeFileSync(histPath, prior, 'utf8')
        } catch {
          // best-effort
        }
      }
      cpSync(src, dest)
    }
  }
}
