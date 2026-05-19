import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import dotenv from 'dotenv'

const envName = process.env.GUILDBOT_ENV || 'dev'

// GUILDBOT_ENV_DIR allows test injection of a custom directory (R5.3)
export const ENV_DIR = process.env.GUILDBOT_ENV_DIR || join(homedir(), `.guildbot-${envName}`)
export const ENV_NAME = envName

// Load .env from environment dir at module load time (before any feature module imports)
dotenv.config({ path: join(ENV_DIR, '.env') })

const DATA_DIRS = ['db', 'recordings', 'sessions', 'sessions/context', 'media', 'exports'] as const

/**
 * Ensure environment directory exists and is populated.
 * Call once at startup before any DB or file operations.
 *
 * @param codebaseRoot  - absolute path to the project directory (where tools/ and skills/ live)
 * @param envDir        - target environment dir; defaults to ENV_DIR (injectable for tests)
 */
export function ensureEnvironment(codebaseRoot: string, envDir: string = ENV_DIR): void {
  mkdirSync(envDir, { recursive: true })

  // Seed tools and skills on first run; do not overwrite (R3.1, R3.2)
  const envTools = join(envDir, 'tools')
  if (!existsSync(envTools) && existsSync(join(codebaseRoot, 'tools'))) {
    cpSync(join(codebaseRoot, 'tools'), envTools, { recursive: true })
  }
  const envSkills = join(envDir, 'skills')
  if (!existsSync(envSkills) && existsSync(join(codebaseRoot, 'skills'))) {
    cpSync(join(codebaseRoot, 'skills'), envSkills, { recursive: true })
  }

  for (const dir of DATA_DIRS) {
    mkdirSync(join(envDir, dir), { recursive: true })
  }

  // Copy .env.example → .env if no .env present yet (R3.4)
  const envFile = join(envDir, '.env')
  const exampleFile = join(codebaseRoot, '.env.example')
  if (!existsSync(envFile) && existsSync(exampleFile)) {
    cpSync(exampleFile, envFile)
  }
}

/**
 * Re-copy tools/skills from codebase into an environment.
 * Set force=true to overwrite custom changes (R3.3).
 */
export function syncEnvironment(codebaseRoot: string, envDir: string = ENV_DIR, force = false): void {
  const envTools = join(envDir, 'tools')
  if (!existsSync(envTools) || force) {
    cpSync(join(codebaseRoot, 'tools'), envTools, { recursive: true })
  }
  const envSkills = join(envDir, 'skills')
  if (!existsSync(envSkills) || force) {
    cpSync(join(codebaseRoot, 'skills'), envSkills, { recursive: true })
  }
}
