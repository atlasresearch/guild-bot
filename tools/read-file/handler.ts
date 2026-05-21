import fsp from 'node:fs/promises'
import { loadConfig, paths } from '@guildbot/guild-config'
import { resolveAllowedPath } from '@guildbot/llm-edit'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args) => {
  const filePath = String(args.file_path ?? '')
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

  let content: string
  try {
    content = await fsp.readFile(resolved.absPath, 'utf8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      return {
        success: false,
        data: {
          error: `File not found: "${resolved.relPath}". The path is allowlisted but the file does not exist yet.`,
        },
      }
    }
    return { success: false, data: { error: `Failed to read "${resolved.relPath}": ${e?.message ?? e}` } }
  }

  const lines = content.split('\n')
  const padWidth = String(lines.length).length
  const numberedView = lines
    .map((line, i) => `${String(i + 1).padStart(padWidth, ' ')}: ${line}`)
    .join('\n')

  console.log(`[read_file] path=${resolved.relPath} bytes=${content.length}`)
  return {
    success: true,
    data: {
      file_path: resolved.relPath,
      content,
      lineCount: lines.length,
      numberedView,
    },
  }
}

export default handler
