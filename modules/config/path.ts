import { join } from 'node:path'
import { ENV_DIR } from './env'

// All runtime state lives under ENV_DIR (~/.guildbot-<env>/)  (R1.1, R2.1)
export const DB_DIR         = join(ENV_DIR, 'db')
export const RECORDINGS_DIR = join(ENV_DIR, 'recordings')
export const SESSIONS_DIR   = join(ENV_DIR, 'sessions')
export const CONTEXT_DIR    = join(ENV_DIR, 'sessions', 'context')
export const MEDIA_DIR      = join(ENV_DIR, 'media')
export const EXPORTS_DIR    = join(ENV_DIR, 'exports')
export const TOOLS_DIR      = join(ENV_DIR, 'tools')
export const SKILLS_DIR     = join(ENV_DIR, 'skills')

export const DEFAULT_MODEL  = process.env.DEFAULT_MODEL!
