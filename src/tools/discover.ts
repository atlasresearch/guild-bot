import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '@guildbot/guild-config'
import type { Tool } from 'ollama'
import type { ToolHandler } from './types'

// Read all tools/<name>/definition.json and return Ollama Tool[]
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
      // R1.3: silently skip directories that lack a definition.json
    }
  }
  return definitions
}

// Dynamically import a tool's handler.ts and return the default export
export async function loadToolHandler(name: string, toolsDir?: string): Promise<ToolHandler> {
  const dir = toolsDir ?? paths().tools
  // Tool definitions use underscores (search_messages) but directories use hyphens (search-messages)
  const dirName = name.replace(/_/g, '-')
  // Try .ts first (tsx loader), then .mjs (for tests with temp fixtures)
  for (const ext of ['handler.ts', 'handler.mjs']) {
    const handlerPath = join(dir, dirName, ext)
    try {
      const mod = await import(handlerPath)
      return mod.default as ToolHandler
    } catch {
      continue
    }
  }
  throw new Error(`No handler found for tool "${name}" in ${join(dir, dirName)}`)
}
