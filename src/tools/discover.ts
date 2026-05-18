import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Tool } from 'ollama'
import type { ToolHandler } from './types'

const DEFAULT_TOOLS_DIR = join(import.meta.dirname, '..', '..', 'tools')

// Read all tools/<name>/definition.json and return Ollama Tool[]
export async function discoverToolDefinitions(toolsDir = DEFAULT_TOOLS_DIR): Promise<Tool[]> {
  const entries = await readdir(toolsDir, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())
  const definitions: Tool[] = []
  for (const d of dirs) {
    try {
      const raw = await readFile(join(toolsDir, d.name, 'definition.json'), 'utf-8')
      definitions.push(JSON.parse(raw) as Tool)
    } catch {
      // R1.3: silently skip directories that lack a definition.json
    }
  }
  return definitions
}

// Dynamically import a tool's handler.ts and return the default export
export async function loadToolHandler(name: string, toolsDir = DEFAULT_TOOLS_DIR): Promise<ToolHandler> {
  // Tool definitions use underscores (search_messages) but directories use hyphens (search-messages)
  const dirName = name.replace(/_/g, '-')
  // Try .ts first (tsx loader), then .mjs (for tests with temp fixtures)
  for (const ext of ['handler.ts', 'handler.mjs']) {
    const handlerPath = join(toolsDir, dirName, ext)
    try {
      const mod = await import(handlerPath)
      return mod.default as ToolHandler
    } catch {
      continue
    }
  }
  throw new Error(`No handler found for tool "${name}" in ${join(toolsDir, dirName)}`)
}
