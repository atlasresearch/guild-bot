import fsp from 'node:fs/promises'
import { dirname } from 'node:path'
import { loadConfig, paths } from '@guildbot/guild-config'
import { atomicWrite } from '@guildbot/interfaces'
import { applyEdits, resolveAllowedPath } from '@guildbot/llm-edit'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args) => {
  const filePath = String(args.file_path ?? '')
  if (typeof args.content !== 'string') {
    return {
      success: false,
      data: { error: `content must be a string (got ${typeof args.content}).` },
    }
  }
  const newContent = args.content

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

  // applyEdits with whole-file semantics — keeps the validator hook available
  // for callers that wrap this via a typed write API later.
  const result = await applyEdits('', { kind: 'whole-file', content: newContent })
  if (!result.success) {
    return { success: false, data: { error: result.error } }
  }

  try {
    await fsp.mkdir(dirname(resolved.absPath), { recursive: true })
    await atomicWrite(resolved.absPath, result.newContent)
  } catch (e: any) {
    return { success: false, data: { error: `Failed to write "${resolved.relPath}": ${e?.message ?? e}` } }
  }

  console.log(`[rewrite_file] path=${resolved.relPath} bytes=${Buffer.byteLength(result.newContent, 'utf8')} result=success`)
  return {
    success: true,
    data: {
      file_path: resolved.relPath,
      newByteSize: Buffer.byteLength(result.newContent, 'utf8'),
    },
  }
}

export default handler
