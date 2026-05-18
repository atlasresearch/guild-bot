import { resolve } from 'node:path'
import { ROOT_DIR } from '@guildbot/config'
import { exportMermaid } from '@guildbot/exporters'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args, _ctx) => {
  const nodes = args.nodes as Array<{ label: string; type: string }>
  const relationships = args.relationships as Array<{ subject: string; object: string; predicate: string }>
  const dir = resolve(ROOT_DIR, '.tmp', 'exports')

  const { outPath, svgPath, pngPath } = await exportMermaid(
    dir,
    'diagram',
    nodes,
    relationships
  )
  return { success: true, data: { png_path: pngPath, svg_path: svgPath } }
}

export default handler
