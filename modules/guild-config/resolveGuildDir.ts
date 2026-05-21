import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Resolve the active guild directory.
 *
 * Precedence:
 *   1. `--guild-dir <path>` CLI argument (parsed from process.argv)
 *   2. `GUILDBOT_GUILD_DIR` env var
 *   3. Default: `~/.guildbot/default/`
 *
 * The returned path is canonicalised — symlinks followed, `..` resolved.
 */
export function resolveGuildDir(argv: string[] = process.argv): string {
  const cli = parseGuildDirArg(argv)
  if (cli) return resolve(cli)

  const envDir = process.env.GUILDBOT_GUILD_DIR
  if (envDir) return resolve(envDir)

  return resolve(join(homedir(), '.guildbot', 'default'))
}

/**
 * Pull the value of `--guild-dir <path>` (or `--guild-dir=<path>`) from a string array.
 * Returns undefined if not present. Exposed for tests.
 */
export function parseGuildDirArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--guild-dir') return argv[i + 1]
    if (a && a.startsWith('--guild-dir=')) return a.slice('--guild-dir='.length)
  }
  return undefined
}

export class GuildDirNotFoundError extends Error {
  constructor(public readonly guildDir: string) {
    super(
      `Guild directory does not exist: ${guildDir}\n` +
        `Run \`guildbot init ${guildDir}\` to create it.`,
    )
    this.name = 'GuildDirNotFoundError'
  }
}

/**
 * Resolve and validate that the guild dir exists. Throws GuildDirNotFoundError otherwise.
 */
export function resolveGuildDirOrThrow(argv: string[] = process.argv): string {
  const dir = resolveGuildDir(argv)
  if (!existsSync(dir)) throw new GuildDirNotFoundError(dir)
  return dir
}
