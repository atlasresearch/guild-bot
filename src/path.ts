import appRootPath from 'app-root-path'
import path from 'path'

export const CHAT_DIR = path.resolve(appRootPath.path, '.tmp', 'chat-sessions')
export const DEFAULT_MODEL = process.env.TOOLS_MODEL || 'github-copilot/gpt-5-mini'
export const DEFAULT_SESSION_DIR = path.resolve(appRootPath.path, '.tmp', 'tools-sessions')
