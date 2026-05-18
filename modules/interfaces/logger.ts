export const DEV_LOG =
  process.env.NODE_ENV === 'development' ||
  process.env.DEV_LOG === '1' ||
  process.env.DEV_LOG === 'true' ||
  !!process.env.TEST

export function debug(...args: unknown[]) {
  if (DEV_LOG) console.debug('[debug]', ...args)
}

export function info(...args: unknown[]) {
  console.info('[info]', ...args)
}

export function warn(...args: unknown[]) {
  console.warn('[warn]', ...args)
}

/** Verbose logging for LLM & tool calls — only in dev mode */
export function verbose(label: string, data?: unknown) {
  if (!DEV_LOG) return
  if (data !== undefined) {
    console.debug(`[verbose] ${label}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  } else {
    console.debug(`[verbose] ${label}`)
  }
}
