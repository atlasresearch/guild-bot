#!/usr/bin/env node
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  audioToTranscript,
  Relationship,
  toKumuJSON,
  transcribeAudioFile,
  transcriptToDiagrams
} from '@guildbot/media'
import { buildMermaid, exportMermaid } from '@guildbot/exporters'
import { ensureEnvironment, syncEnvironment } from '@guildbot/config'
import { loadToolHandler } from './tools/discover'

const CODEBASE_ROOT = path.join(import.meta.dirname, '..')

// ── Media commands ──────────────────────────────────────────────────────────

async function cmdTranscribe(input: string, output: string) {
  if (!input || !output) {
    throw new Error('Usage: transcribe <input.ext|youtube-url> <outputDir|output.txt>')
  }

  if (input.includes('youtube.com') || input.includes('youtu.be')) {
    const id = await audioToTranscript(input)
    const res = await transcriptToDiagrams(id)
    const files = await fsp.readdir(res.dir)
    const txts = files.filter((f) => f.endsWith('.txt'))
    console.log('Transcripts written:')
    for (const t of txts) console.log(path.join(res.dir, t))
    return
  }

  const audioPath = input
  if (!fs.existsSync(audioPath)) throw new Error(`Input not found: ${audioPath}`)
  const tmpDir = require('node:os').tmpdir()
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

  const mermaid = buildMermaid(nodes, relationships)
  await fsp.writeFile(output, mermaid, 'utf8')

  try {
    const outDir = path.dirname(output)
    const base = path.basename(output, path.extname(output))
    await exportMermaid(outDir, base, nodes, relationships)
  } catch (e: any) {
    console.warn('Failed to generate additional mermaid outputs:', e?.message ?? e)
  }

  console.log('Mermaid diagram written to', output)
}

// ── Environment management commands ─────────────────────────────────────────

/**
 * Initialize (or re-verify) an environment directory.
 * guildbot init [envName]
 */
async function cmdInit(envName: string = process.env.GUILDBOT_ENV || 'dev') {
  const envDir = path.join(homedir(), `.guildbot-${envName}`)
  ensureEnvironment(CODEBASE_ROOT, envDir)
  console.log(`Environment initialised: ${envDir}`)
  if (!fs.existsSync(path.join(envDir, '.env'))) {
    console.warn(`  Note: no .env found in ${envDir} — copy .env.example and fill in your credentials.`)
  }
}

/**
 * Re-copy tools/skills from the codebase into an existing environment.
 * guildbot sync [envName] [--force]
 */
async function cmdSync(envName: string = process.env.GUILDBOT_ENV || 'dev', force = false) {
  const envDir = path.join(homedir(), `.guildbot-${envName}`)
  syncEnvironment(CODEBASE_ROOT, envDir, force)
  console.log(`Synced tools/skills to ${envDir}${force ? ' (forced)' : ''}`)
}

/**
 * Migrate data from the old in-repo layout to an environment directory.
 *
 * guildbot migrate [--env <envName>] [--from <projectRoot>]
 *
 * Old layout (under projectRoot):
 *   .lancedb_prod/        → <env>/db/
 *   .lancedb/             → dev env db/          (only when migrating dev)
 *   .tmp/recordings/      → <env>/recordings/
 *   .tmp/discord-sessions/       → prod env sessions/
 *   .tmp/discord-dev-sessions/   → dev env sessions/
 *   .tmp/chat-sessions/discord/  → prod env media/
 *   .tmp/chat-sessions/discord-dev/ → dev env media/
 *   .env.prod / .env.dev  → <env>/.env
 */
async function cmdMigrate(argv: string[]) {
  let fromDir = CODEBASE_ROOT
  let envName = 'prod'

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env' && argv[i + 1]) envName = argv[++i]
    else if (argv[i] === '--from' && argv[i + 1]) fromDir = argv[++i]
  }

  const envDir = path.join(homedir(), `.guildbot-${envName}`)
  const isDev = envName === 'dev'

  console.log(`Migrating ${isDev ? 'dev' : 'prod'} data:  ${fromDir}  →  ${envDir}`)

  // Ensure base dirs exist
  ensureEnvironment(CODEBASE_ROOT, envDir)

  const copyDir = async (src: string, dest: string, label: string) => {
    if (!fs.existsSync(src)) {
      console.log(`  skip ${label} (source not found: ${src})`)
      return
    }
    console.log(`  ${label}: ${src} → ${dest}`)
    await fsp.cp(src, dest, { recursive: true })
  }

  if (isDev) {
    await copyDir(path.join(fromDir, '.lancedb'), path.join(envDir, 'db'), 'dev DB')
    await copyDir(
      path.join(fromDir, '.tmp', 'discord-dev-sessions'),
      path.join(envDir, 'sessions'),
      'dev sessions'
    )
    const devChatSrc = path.join(fromDir, '.tmp', 'chat-sessions', 'discord-dev')
    await copyDir(devChatSrc, path.join(envDir, 'media'), 'dev media')
    const devEnv = path.join(fromDir, '.env.dev')
    const destEnv = path.join(envDir, '.env')
    if (fs.existsSync(devEnv)) {
      await fsp.copyFile(devEnv, destEnv)
      console.log(`  .env.dev → ${destEnv}`)
    }
  } else {
    await copyDir(path.join(fromDir, '.lancedb_prod'), path.join(envDir, 'db'), 'prod DB')
    await copyDir(path.join(fromDir, '.tmp', 'recordings'), path.join(envDir, 'recordings'), 'recordings')
    await copyDir(
      path.join(fromDir, '.tmp', 'discord-sessions'),
      path.join(envDir, 'sessions'),
      'prod sessions'
    )
    const prodChatSrc = path.join(fromDir, '.tmp', 'chat-sessions', 'discord')
    await copyDir(prodChatSrc, path.join(envDir, 'media'), 'prod media')
    const prodEnv = path.join(fromDir, '.env.prod')
    const destEnv = path.join(envDir, '.env')
    if (fs.existsSync(prodEnv)) {
      await fsp.copyFile(prodEnv, destEnv)
      console.log(`  .env.prod → ${destEnv}`)
    }
  }

  console.log(`Migration complete → ${envDir}`)
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(argv: string[]) {
  const cmd = argv[0]
  try {
    if (cmd === 'transcribe') await cmdTranscribe(argv[1], argv[2])
    else if (cmd === 'diagram') await cmdDiagram(argv[1], argv[2])
    else if (cmd === 'kumu') await cmdKumu(argv[1], argv[2])
    else if (cmd === 'mermaid') await cmdMermaid(argv[1], argv[2])
    else if (cmd === 'init') await cmdInit(argv[1])
    else if (cmd === 'sync') await cmdSync(argv[1], argv.includes('--force'))
    else if (cmd === 'migrate') await cmdMigrate(argv.slice(1))
    else {
      console.log('Usage: guildbot <command> [args]')
      console.log('Commands:')
      console.log('  transcribe <input.ext> <output.txt>')
      console.log('  diagram    <transcript.txt> <graph.json>')
      console.log('  kumu       <input.txt> <output.json>')
      console.log('  mermaid    <input.txt> <output.mmd>')
      console.log('  init       [envName]              — create/seed environment directory')
      console.log('  sync       [envName] [--force]    — re-copy tools/skills from codebase')
      console.log('  migrate    [--env <name>] [--from <dir>]  — move old in-repo data to env dir')
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

export { cmdDiagram, cmdKumu, cmdTranscribe, cmdInit, cmdSync, cmdMigrate }
