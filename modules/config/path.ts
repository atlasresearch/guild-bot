import appRootPath from 'app-root-path'
import dotenv from 'dotenv'
import path from 'path'

// use .env.dev in dev mode, .env.prod in production
if (process.env.NODE_ENV === 'development') {
  dotenv.config({ path: '.env.dev' })
  console.log('Loaded development .env.dev file')
} else if (process.env.NODE_ENV === 'test') {
  dotenv.config({ path: '.env.test' })
  console.log('Loaded test .env.test file')
} else {
  dotenv.config({ path: '.env.prod' })
  console.log('Loaded production .env.prod file')
}

export const CHAT_DIR = path.resolve(appRootPath.path, '.tmp', 'chat-sessions')
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL!
export const DEFAULT_SESSION_DIR = path.resolve(appRootPath.path, '.tmp', 'tools-sessions')
