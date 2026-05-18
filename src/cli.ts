#!/usr/bin/env node
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  audioToTranscript,
  Relationship,
  toKumuJSON,
  transcribeAudioFile,
  transcriptToDiagrams
} from '@guildbot/media'
import { buildMermaid, exportMermaid } from '@guildbot/exporters'
import { loadToolHandler } from './tools/discover'
// audioToDiagram will handle YouTube download+split; whisper is used internally there

async function cmdTranscribe(input: string, output: string) {
  if (!input || !output) {
    throw new Error('Usage: transcribe <input.ext|youtube-url> <outputDir|output.txt>')
  }

  // If input is a YouTube URL, run the full audio->diagram pipeline which will download, transcribe and split
  if (input.includes('youtube.com') || input.includes('youtu.be')) {
    const id = await audioToTranscript('cli', input)
    const res = await transcriptToDiagrams('cli', id)
    const files = await fsp.readdir(res.dir)
    const txts = files.filter((f) => f.endsWith('.txt'))
    console.log('Transcripts written:')
    for (const t of txts) console.log(path.join(res.dir, t))
    return
  }

  // Non-YouTube: treat as a local audio file and create a single transcript file
  const audioPath = input
  if (!fs.existsSync(audioPath)) throw new Error(`Input not found: ${audioPath}`)
  const tmpDir = os.tmpdir()
  await fsp.mkdir(tmpDir, { recursive: true })
  const transcriptPath = path.join(tmpDir, `${path.basename(audioPath, path.extname(audioPath))}.txt`)

  const transcript = await transcribeAudioFile(audioPath, transcriptPath)
  await fsp.writeFile(output, transcript, 'utf8')
  console.log('Transcript written to', output)
}

async function cmdDiagram(input: string, output: string) {
  if (!input || !output) throw new Error('Usage: diagram <input.txt> <output.json>')
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`)
  const transcript = await fsp.readFile(input, 'utf8')
  const handler = await loadToolHandler('extract-causal-relationships')
  const result = await handler(
    { text: transcript.split('\n').filter((line) => line.trim()).join('\n'), prompt: 'userPrompt' },
    {}
  )

  if (!result.success) {
    throw new Error(`Failed to generate causal relationships: ${(result.data as any)?.error}`)
  }

  const { nodes, relationships } = result.data as any

  await fsp.writeFile(output, JSON.stringify({ nodes, relationships }, null, 2), 'utf8')
  console.log('Diagram JSON written to', output)
}

async function cmdKumu(input: string, output: string) {
  if (!input || !output) throw new Error('Usage: kumu <graph.json> <output.json>')
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`)

  const graph = JSON.parse(await fsp.readFile(input, 'utf8'))
  const rawNodes: any[] = graph.nodes ?? graph.elements ?? []
  const rawRels: any[] = graph.relationships ?? graph.connections ?? []

  if (!Array.isArray(rawNodes) || !Array.isArray(rawRels)) {
    throw new Error("Input graph must contain arrays 'nodes' and 'relationships' (or 'elements'/'connections')")
  }

  const nodes = rawNodes
    .map((n: any) => (typeof n === 'string' ? { label: n } : { label: n.label ?? n.name ?? String(n), type: n.type }))
    .filter((n) => n && (n as any).label)

  const relationships: Relationship[] = []
  for (const r of rawRels) {
    if (!r) continue
    if (typeof r === 'object') {
      if ('subject' in r && 'predicate' in r && 'object' in r) {
        relationships.push({ subject: String(r.subject), predicate: String(r.predicate), object: String(r.object) })
        continue
      }
      // support connection-style objects { from, to, label }
      if ('from' in r && 'to' in r) {
        relationships.push({
          subject: String(r.from),
          predicate: String(r.label ?? r.predicate ?? ''),
          object: String(r.to)
        })
        continue
      }
    }
    // do not accept legacy string relationship format for CLI input
    throw new Error('Relationships must be objects with {subject,predicate,object} or {from,to,label}')
  }

  const kumu = toKumuJSON(nodes, relationships)
  await fsp.writeFile(output, JSON.stringify(kumu, null, 2), 'utf8')
  console.log('Kumu JSON written to', output)
}

async function cmdMermaid(input: string, output: string) {
  if (!input || !output) throw new Error('Usage: mermaid <graph.json> <output.mmd>')
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`)

  const graph = JSON.parse(await fsp.readFile(input, 'utf8'))
  const rawNodes: any[] = graph.nodes ?? graph.elements ?? []
  const rawRels: any[] = graph.relationships ?? graph.connections ?? []

  if (!Array.isArray(rawNodes) || !Array.isArray(rawRels)) {
    throw new Error("Input graph must contain arrays 'nodes' and 'relationships' (or 'elements'/'connections')")
  }

  const nodes = rawNodes
    .map((n: any) => (typeof n === 'string' ? { label: n } : { label: n.label ?? n.name ?? String(n), type: n.type }))
    .filter((n) => n && (n as any).label)
  const relationships: Relationship[] = []
  for (const r of rawRels) {
    if (!r) continue
    if (typeof r === 'object') {
      if ('subject' in r && 'predicate' in r && 'object' in r) {
        relationships.push({ subject: String(r.subject), predicate: String(r.predicate), object: String(r.object) })
        continue
      }
      if ('from' in r && 'to' in r) {
        relationships.push({
          subject: String(r.from),
          predicate: String(r.label ?? r.predicate ?? ''),
          object: String(r.to)
        })
        continue
      }
    }
    throw new Error('Relationships must be objects with {subject,predicate,object} or {from,to,label}')
  }

  // Convert to mermaid syntax and write requested output (.mmd)
  const mermaid = buildMermaid(nodes, relationships)
  await fsp.writeFile(output, mermaid, 'utf8')

  // Also produce exporter outputs (mdd + svg) beside the output file's directory
  try {
    const outDir = path.dirname(output)
    const base = path.basename(output, path.extname(output))
    await exportMermaid(outDir, base, nodes, relationships)
  } catch (e: any) {
    console.warn('Failed to generate additional mermaid outputs:', e?.message ?? e)
  }

  console.log('Mermaid diagram written to', output)
}

async function main(argv: string[]) {
  const cmd = argv[0]
  try {
    if (cmd === 'transcribe') await cmdTranscribe(argv[1], argv[2])
    else if (cmd === 'diagram') await cmdDiagram(argv[1], argv[2])
    else if (cmd === 'kumu') await cmdKumu(argv[1], argv[2])
    else if (cmd === 'mermaid') await cmdMermaid(argv[1], argv[2])
    else {
      console.log('Usage: npx <pkg> <command> [args]')
      console.log('Commands:')
      console.log('  transcribe <input.ext> <output.txt>')
      console.log('  diagram <transcript.txt> <graph.json>')
      console.log('  kumu <input.txt> <output.json>')
      console.log('  mermaid <input.txt> <output.mmd>')
      process.exit(1)
    }
  } catch (err: any) {
    console.error('Error:', err?.message ?? err)
    process.exit(1)
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
}

export { cmdDiagram, cmdKumu, cmdTranscribe }
