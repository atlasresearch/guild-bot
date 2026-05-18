export { DEFAULT_MODEL, CHAT_DIR, DEFAULT_SESSION_DIR } from './path'

export const UNIVERSE = process.env.UNIVERSE || 'discord-dev'

import appRootPath from 'app-root-path'
export const ROOT_DIR = appRootPath.toString()
