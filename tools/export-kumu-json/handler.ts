import { resolve } from 'node:path'
import { ROOT_DIR } from '@guildbot/config'
import { exportGraphJSON } from '@guildbot/exporters'
import { toKumuJSON } from '@guildbot/media'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args, _ctx) => {
  const nodes = args.nodes as Array<{ label: string; type: string }>
  const relationships = args.relationships as Array<{ subject: string; object: string; predicate: string }>
  const dir = resolve(ROOT_DIR, '.tmp', 'exports')

  const kumu = toKumuJSON(nodes, relationships)
  const { jsonPath } = await exportGraphJSON(dir, nodes, relationships)
  return { success: true, data: { file_path: jsonPath, kumu } }
}

export default handler
