import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverToolDefinitions, loadToolHandler } from './discover'

// Tests exercise real discovery functions against fixture directories on disk.
// No mocking of internal modules (R7.9).

describe('discoverToolDefinitions', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tools-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('should discover definition.json files from tool subdirectories', async () => {
    await mkdir(join(tempDir, 'tool-a'))
    await writeFile(
      join(tempDir, 'tool-a', 'definition.json'),
      JSON.stringify({
        type: 'function',
        function: { name: 'tool_a', description: 'Test tool A', parameters: { type: 'object', properties: {} } },
      })
    )
    await mkdir(join(tempDir, 'tool-b'))
    await writeFile(
      join(tempDir, 'tool-b', 'definition.json'),
      JSON.stringify({
        type: 'function',
        function: { name: 'tool_b', description: 'Test tool B', parameters: { type: 'object', properties: {} } },
      })
    )

    const tools = await discoverToolDefinitions(tempDir)
    expect(tools).toHaveLength(2)
    const names = tools.map((t: any) => t.function.name).sort()
    expect(names).toEqual(['tool_a', 'tool_b'])
  })

  it('should silently skip directories without definition.json', async () => {
    await mkdir(join(tempDir, 'valid-tool'))
    await writeFile(
      join(tempDir, 'valid-tool', 'definition.json'),
      JSON.stringify({
        type: 'function',
        function: { name: 'valid_tool', description: 'Valid', parameters: { type: 'object', properties: {} } },
      })
    )
    await mkdir(join(tempDir, 'empty-dir'))

    const tools = await discoverToolDefinitions(tempDir)
    expect(tools).toHaveLength(1)
    expect((tools[0] as any).function.name).toBe('valid_tool')
  })

  it('should return empty array when tools directory has no subdirectories', async () => {
    const tools = await discoverToolDefinitions(tempDir)
    expect(tools).toEqual([])
  })
})

describe('loadToolHandler', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tools-handler-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('should dynamically import a handler and return its default export', async () => {
    await mkdir(join(tempDir, 'test-tool'))
    await writeFile(
      join(tempDir, 'test-tool', 'handler.mjs'),
      `export default async (args, ctx) => ({ success: true, data: { echo: args.input } })`
    )

    const handler = await loadToolHandler('test-tool', tempDir)
    expect(typeof handler).toBe('function')
    const result = await handler({ input: 'hello' }, {})
    expect(result).toEqual({ success: true, data: { echo: 'hello' } })
  })

  it('should throw if the tool directory does not exist', async () => {
    await expect(loadToolHandler('nonexistent', tempDir)).rejects.toThrow()
  })

  it('should normalize underscores to hyphens when resolving tool directories', async () => {
    await mkdir(join(tempDir, 'search-messages'))
    await writeFile(
      join(tempDir, 'search-messages', 'handler.mjs'),
      `export default async (args, ctx) => ({ success: true, data: { found: true } })`
    )

    // LLM sends underscored name, directory uses hyphens
    const handler = await loadToolHandler('search_messages', tempDir)
    expect(typeof handler).toBe('function')
    const result = await handler({}, {})
    expect(result).toEqual({ success: true, data: { found: true } })
  })
})
