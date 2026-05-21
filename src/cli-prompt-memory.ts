// CLI subcommands for prompt and memory (plan 007 R4.4, R5.4).
//
// Usage:
//   guildbot prompt show
//   guildbot prompt set < new-prompt.md          # body via stdin
//   guildbot prompt set --file ./path.md         # body from file
//   guildbot prompt history
//   guildbot prompt revert <timestampOrFilename>
//   guildbot prompt diff
//   guildbot prompt bump                          # bump version on a hand-edit
//
//   guildbot memory show
//   guildbot memory set < new-memory.md
//   guildbot memory set --file ./path.md
//   guildbot memory history
//   guildbot memory revert <timestampOrFilename>
//   guildbot memory forget <pattern>
//   guildbot memory diff
//
// All commands operate on the active guild dir.

import fs from 'node:fs'
import fsp from 'node:fs/promises'

import { z } from 'zod'

import {
  diffAgainstDefault,
  forgetMemory,
  listHistory,
  loadMemory,
  loadPrompt,
  revert as revertPromptOrMemory,
  updateMemory,
  updatePrompt,
} from '@guildbot/guild-config'
import { structured } from '@guildbot/llm'

type Argv = string[]

function getFlag(argv: Argv, name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

function applyGuildDirFlag(argv: Argv): Argv {
  const i = argv.indexOf('--guild-dir')
  if (i < 0) return argv
  const v = argv[i + 1]
  if (!v) throw new Error('--guild-dir requires a value')
  process.env.GUILDBOT_GUILD_DIR = v
  return [...argv.slice(0, i), ...argv.slice(i + 2)]
}

async function readBody(argv: Argv): Promise<string> {
  const fileFlag = getFlag(argv, 'file')
  if (fileFlag) {
    return fsp.readFile(fileFlag, 'utf8')
  }
  if (process.stdin.isTTY) {
    throw new Error(
      'Provide the body via stdin (pipe in a file) or via --file <path>.',
    )
  }
  return new Promise<string>((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buf += chunk
    })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', reject)
  })
}

const FORGET_SCHEMA = z.object({
  rewrittenMemory: z.string(),
  removed: z.array(z.string()),
})

// ── prompt ──────────────────────────────────────────────────────────────────

export async function cmdPrompt(argvIn: Argv) {
  const argv = applyGuildDirFlag(argvIn)
  const sub = argv[0]
  const rest = argv.slice(1)

  if (sub === 'show') {
    const v = await loadPrompt()
    console.log(`# prompt — v${v.version} (updated ${v.updatedAt})\n`)
    console.log(v.content.trim() || '(empty)')
    return
  }
  if (sub === 'history') {
    const entries = listHistory('prompt')
    if (entries.length === 0) {
      console.log('No prompt history entries.')
      return
    }
    for (const e of entries) {
      console.log(`${e.filename}\t${e.timestamp || '?'}\t${e.reason}\t${e.size} bytes`)
    }
    return
  }
  if (sub === 'diff') {
    const diff = await diffAgainstDefault('prompt')
    if (!diff) {
      console.log('prompt.md matches the bundled default.')
      return
    }
    console.log(diff)
    return
  }
  if (sub === 'set') {
    const body = await readBody(rest)
    const result = await updatePrompt(body, { reason: `operator:${cliUser()}` })
    console.log(`Updated prompt.md to v${result.version}.`)
    return
  }
  if (sub === 'bump') {
    // Re-read the current body and re-write with an incremented version.
    // This is the "operator hand-edited the file in vim" workflow.
    const cur = await loadPrompt()
    const result = await updatePrompt(cur.content, { reason: `operator:${cliUser()}` })
    console.log(`Bumped prompt.md to v${result.version}.`)
    return
  }
  if (sub === 'revert') {
    const target = rest[0]
    if (!target) throw new Error('Usage: prompt revert <timestampOrFilename>')
    const result = await revertPromptOrMemory('prompt', target, `operator:${cliUser()}`)
    console.log(`Reverted prompt.md to "${target}". Now v${result.version}.`)
    return
  }
  usagePrompt()
}

// ── memory ──────────────────────────────────────────────────────────────────

export async function cmdMemory(argvIn: Argv) {
  const argv = applyGuildDirFlag(argvIn)
  const sub = argv[0]
  const rest = argv.slice(1)

  if (sub === 'show') {
    const v = await loadMemory()
    console.log(`# memory — v${v.version} (updated ${v.updatedAt}, ${v.byteSize} bytes)\n`)
    console.log(v.content.trim() || '(empty)')
    return
  }
  if (sub === 'history') {
    const entries = listHistory('memory')
    if (entries.length === 0) {
      console.log('No memory history entries.')
      return
    }
    for (const e of entries) {
      console.log(`${e.filename}\t${e.timestamp || '?'}\t${e.reason}\t${e.size} bytes`)
    }
    return
  }
  if (sub === 'diff') {
    const diff = await diffAgainstDefault('memory')
    if (!diff) {
      console.log('memory.md matches the bundled default.')
      return
    }
    console.log(diff)
    return
  }
  if (sub === 'set') {
    const body = await readBody(rest)
    const result = await updateMemory(body, { reason: `operator:${cliUser()}` })
    console.log(`Updated memory.md to v${result.version}.`)
    return
  }
  if (sub === 'revert') {
    const target = rest[0] ?? getFlag(rest, 'to')
    if (!target) throw new Error('Usage: memory revert <timestampOrFilename>  (or --to <ts>)')
    const result = await revertPromptOrMemory('memory', target, `operator:${cliUser()}`)
    console.log(`Reverted memory.md to "${target}". Now v${result.version}.`)
    return
  }
  if (sub === 'forget') {
    const pattern = rest.join(' ').trim()
    if (!pattern) throw new Error('Usage: memory forget <pattern>')
    const result = await forgetMemory(pattern, {
      runStructured: async (prompt) => {
        const r = await structured({
          schema: FORGET_SCHEMA,
          schemaName: 'memory_forget',
          messages: [
            {
              role: 'system',
              content:
                'You rewrite a guild bot memory file with content removed per the operator pattern.',
            },
            { role: 'user', content: prompt },
          ],
        })
        if (!r.success) throw new Error(`LLM forget failed: ${r.error}`)
        return r.data
      },
    })
    console.log(
      `Memory forget applied — now v${result.after.version}. Removed ${result.removed.length} entries.`,
    )
    return
  }
  usageMemory()
}

function cliUser(): string {
  return process.env.USER ?? 'cli'
}

function usagePrompt(): never {
  console.log('Usage: guildbot prompt <show|set|history|revert|diff|bump>')
  process.exit(1)
}

function usageMemory(): never {
  console.log('Usage: guildbot memory <show|set|history|revert|forget|diff>')
  process.exit(1)
}

// Re-export to silence the "fs unused" hint if not consumed inline.
void fs
