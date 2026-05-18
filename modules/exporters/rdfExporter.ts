import fsp from 'node:fs/promises'
import path from 'node:path'
import { atomicWrite } from '@guildbot/interfaces'

// Dedicated graph JSON exporter/loader for nodes and relationships.

type Relationship = { subject: string; predicate: string; object: string }

export async function exportGraphJSON(dir: string, nodes: any[], relationships: Relationship[], metadata?: any) {
  await fsp.mkdir(dir, { recursive: true })
  const jsonPath = path.join(dir, `graph.json`)
  const data = {
    nodes,
    relationships,
    // optional metadata block: e.g. { name: '...', thumbnail: 'https://...' }
    ...(metadata ? { metadata } : {})
  }
  await atomicWrite(jsonPath, JSON.stringify(data, null, 2))
  return { jsonPath }
}

export async function loadGraphJSON(dir: string) {
  const filePath = path.join(dir, 'graph.json')
  const raw = await fsp.readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw)
  // Nodes may be strings or objects {label,type}. Preserve original structure.
  const nodes: any[] = Array.isArray(parsed?.nodes) ? parsed.nodes : []
  const relationships: Relationship[] = Array.isArray(parsed?.relationships)
    ? parsed.relationships
        .filter((r: any) => r && typeof r === 'object')
        .map((r: any) => ({
          subject: String(r.subject || ''),
          predicate: String(r.predicate || ''),
          object: String(r.object || '')
        }))
        .filter((r: Relationship) => r.subject && r.predicate && r.object)
    : []
  const metadata: any = parsed?.metadata ?? null
  return { nodes, relationships, metadata }
}

export default exportGraphJSON
