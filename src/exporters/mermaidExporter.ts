import { renderAsync } from '@resvg/resvg-js'
import childProcess from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { atomicWrite } from '../interfaces/atomicWrite'

function sanitizeId(s: string) {
  return s.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'N'
}

function runMermaidCLI(inputPath: string, outputPath: string, args = '') {
  return new Promise<void>((resolve, reject) => {
    const cmd = `mmdc -i ${inputPath} -o ${outputPath}` + args
    let settled = false
    const cp = childProcess.exec(cmd, (error, stdout, stderr) => {
      if (error) {
        if (!settled) {
          settled = true
          reject(error)
        }
        return
      }
      if (stderr) console.error(`stderr: ${stderr}`)
      if (stdout) {
        console.log(`stdout: ${stdout}`)
        if (stdout.includes('Generating single mermaid chart')) {
          resolve()
          cp.kill()
        }
      }
    })

    // interval to check for svg file write
    setInterval(() => {
      fsp
        .access(outputPath)
        .then(() => {
          if (!settled) {
            settled = true
            resolve()
            cp.kill()
          }
        })
        .catch(() => {
          // not yet written
        })
    }, 500)

    cp.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        reject(new Error(`mmdc exited with code ${code}${signal ? ` signal ${signal}` : ''}`))
      } else {
        resolve()
      }
    })

    cp.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
  })
}

/**
 * Builds a Mermaid diagram definition from the given nodes and relationships.
 * @param nodes The nodes to include in the diagram.
 * @param relationships The relationships between the nodes.
 * @returns The Mermaid diagram definition as a string.
 */
export function buildMermaid(
  nodes: Array<string | { label?: string; type?: string }>,
  relationships: Array<{
    subject: string
    predicate: string
    object: string
    subjectType?: string
    objectType?: string
  }>
) {
  const sanitize = sanitizeId
  // Normalize node labels from either string or object
  const labels = Array.from(new Set((nodes || []).map((n) => (typeof n === 'string' ? n : n.label || String(n)))))
  const nodeLines = labels.map((n) => `${sanitize(n)}["${n.replace(/"/g, '\"')}"]`)

  // Build a node -> type map from provided node objects or relationships; default to 'other'
  const nodeTypes: { [k: string]: string } = {}
  for (const l of labels) nodeTypes[l] = 'other'
  for (const n of nodes || []) {
    if (typeof n === 'object' && n && (n.label || n.type)) {
      const lab = String(n.label || '')
      if (lab) nodeTypes[lab] = String(n.type || nodeTypes[lab] || 'other')
    }
  }
  for (const rel of relationships || []) {
    if (!rel || typeof rel !== 'object') continue
    if (rel.subject && rel.subjectType) nodeTypes[rel.subject] = String(rel.subjectType)
    if (rel.object && rel.objectType) nodeTypes[rel.object] = String(rel.objectType)
  }

  const edgeLines: string[] = []
  for (const rel of relationships) {
    if (!rel || typeof rel !== 'object') continue
    const from = rel.subject || ''
    const to = rel.object || ''
    const label = rel.predicate === 'negative' ? 'decreases' : ''
    if (from && to)
      edgeLines.push(
        `${sanitize(from)} ${label ? `-- "${String(label).replace(/\"/g, '\\"')}" -->` : '-->'} ${sanitize(to)}`
      )
  }

  // Map types to colours: drivers=green, obstacles=red, actors=amber, other=blue
  const colours: { [k: string]: string } = {
    driver: '#88cc88',
    obstacle: '#ff8888',
    actor: '#ffcc66',
    other: '#88aaff'
  }

  const styleLines: string[] = []
  for (const n of labels) {
    const t = (nodeTypes[n] || 'other').toLowerCase()
    const c = colours[t] || colours['other']
    styleLines.push(`style ${sanitize(n)} fill:${c},stroke:#333,stroke-width:1px`)
  }

  return ['graph TD', ...nodeLines, ...edgeLines, '', ...styleLines].join('\n') + '\n'
}

/**
 * Exports the given nodes and relationships as a Mermaid diagram file and attempts to render an SVG.
 * @param dir The output directory.
 * @param baseName The base name for the output files (without extension).
 * @param nodes The nodes to include in the diagram.
 * @param relationships The relationships between the nodes.
 * @returns An object containing the paths to the generated files.
 */
export async function exportMermaid(
  dir: string,
  baseName: string,
  nodes: Array<string | { label?: string; type?: string }>,
  relationships: Array<{ subject: string; predicate: string; object: string }>
) {
  await fsp.mkdir(dir, { recursive: true })

  const chart = buildMermaid(nodes, relationships)

  const outPath = path.join(dir, `${baseName}.mdd`)
  const svgPath = path.join(dir, `${baseName}.svg`) as `${string}.svg`
  const pngPath = path.join(dir, `${baseName}.png`) as `${string}.png`

  await atomicWrite(outPath, chart)
  try {
    await runMermaidCLI(outPath, svgPath)

    let pngArgs = ''
    try {
      const svgText = await fsp.readFile(svgPath, 'utf8')
      const img = await renderAsync(svgText)
      const width = typeof img.width === 'number' ? Math.round(img.width) : undefined
      const height = typeof img.height === 'number' ? Math.round(img.height) : undefined
      if (width && height) {
        pngArgs = ` --width ${width} --height ${height}`
      } else {
        pngArgs = ' --scale 2'
      }
    } catch {
      pngArgs = ' --scale 2'
    }

    await runMermaidCLI(outPath, pngPath, pngArgs)

    return { outPath, svgPath, pngPath }
  } catch (e: any) {
    console.warn('mermaid SVG render failed:', e?.message ?? e)
  }

  return { outPath }
}

export default exportMermaid
