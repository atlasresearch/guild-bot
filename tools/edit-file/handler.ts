import fsp from 'node:fs/promises'
import { loadConfig, paths } from '@guildbot/guild-config'
import { atomicWrite } from '@guildbot/interfaces'
import { applyEdits, resolveAllowedPath, type SearchReplaceBlock } from '@guildbot/llm-edit'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args) => {
  const filePath = String(args.file_path ?? '')
  const rawBlocks = args.blocks
  if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) {
    return {
      success: false,
      data: { error: 'blocks must be a non-empty array of { search, replace, start_line? } objects.' },
    }
  }
  const blocks: SearchReplaceBlock[] = []
  for (let i = 0; i < rawBlocks.length; i++) {
    const b = rawBlocks[i] as Record<string, unknown>
    if (typeof b?.search !== 'string' || typeof b?.replace !== 'string') {
      return {
        success: false,
        data: {
          error: `blocks[${i}] is malformed: search and replace must both be strings (got search=${typeof b?.search}, replace=${typeof b?.replace}).`,
        },
      }
    }
    blocks.push({
      search: b.search,
      replace: b.replace,
      startLine: typeof b.start_line === 'number' ? b.start_line : undefined,
    })
  }

  const cfg = loadConfig()
  const guildDir = paths().root
  const resolved = await resolveAllowedPath({
    filePath,
    guildDir,
    allowlist: cfg.tools.editAllowlist,
  })
  if (!resolved.ok) {
    return { success: false, data: { error: resolved.error } }
  }

  let current: string
  try {
    current = await fsp.readFile(resolved.absPath, 'utf8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      return {
        success: false,
        data: {
          error: `File not found: "${resolved.relPath}". Cannot edit a file that does not exist — use rewrite_file to create it.`,
        },
      }
    }
    return { success: false, data: { error: `Failed to read "${resolved.relPath}": ${e?.message ?? e}` } }
  }

  const result = await applyEdits(current, { kind: 'search-replace', blocks })
  if (!result.success) {
    return { success: false, data: { error: result.error } }
  }

  try {
    await atomicWrite(resolved.absPath, result.newContent)
  } catch (e: any) {
    return { success: false, data: { error: `Failed to write "${resolved.relPath}": ${e?.message ?? e}` } }
  }

  console.log(`[edit_file] path=${resolved.relPath} blocks=${result.blocksApplied} result=success`)
  return {
    success: true,
    data: {
      file_path: resolved.relPath,
      blocksApplied: result.blocksApplied,
      newByteSize: Buffer.byteLength(result.newContent, 'utf8'),
    },
  }
}

export default handler
