import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '@guildbot/guild-config'
import type { LlmTool as Tool } from '@guildbot/llm'
import type { ToolHandler } from './types'

// Read all tools/<name>/definition.json from the active guild's tools/ dir
// (per-guild containment, plan 003). initGuildDir resyncs them from the
// codebase on every startup so the per-guild copy stays current.
export async function discoverToolDefinitions(toolsDir?: string): Promise<Tool[]> {
  const dir = toolsDir ?? paths().tools
  const entries = await readdir(dir, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())
  const definitions: Tool[] = []
  for (const d of dirs) {
    try {
      const raw = await readFile(join(dir, d.name, 'definition.json'), 'utf-8')
      definitions.push(JSON.parse(raw) as Tool)
    } catch {
      // silently skip directories that lack a definition.json
    }
  }
  return definitions
}

// Dynamically import a tool's handler.ts and return the default export.
// Surfaces the actual import error when the handler file exists but fails to
// load (stale code, missing deps, syntax error) — much easier to diagnose than
// the old "No handler found" blanket message.
export async function loadToolHandler(name: string, toolsDir?: string): Promise<ToolHandler> {
  const dir = toolsDir ?? paths().tools
  // Tool definitions use underscores (search_messages); directories use hyphens (search-messages)
  const dirName = name.replace(/_/g, '-')

  const candidates = ['handler.ts', 'handler.mjs', 'handler.js']
  const existing = candidates
    .map((ext) => join(dir, dirName, ext))
    .filter((p) => existsSync(p))

  if (existing.length === 0) {
    throw new Error(`No handler found for tool "${name}" in ${join(dir, dirName)}`)
  }

  let lastError: unknown
  for (const handlerPath of existing) {
    try {
      const mod = await import(handlerPath)
      return mod.default as ToolHandler
    } catch (e) {
      lastError = e
    }
  }
  throw new Error(
    `Failed to load handler for tool "${name}" from ${join(dir, dirName)}: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}
