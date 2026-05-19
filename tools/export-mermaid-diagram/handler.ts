import { EXPORTS_DIR } from '@guildbot/config'
import { exportMermaid } from '@guildbot/exporters'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args, _ctx) => {
  const nodes = args.nodes as Array<{ label: string; type: string }>
  const relationships = args.relationships as Array<{ subject: string; object: string; predicate: string }>

  const { svgPath, pngPath } = await exportMermaid(EXPORTS_DIR, 'diagram', nodes, relationships)
  return { success: true, data: { png_path: pngPath, svg_path: svgPath } }
}

export default handler
