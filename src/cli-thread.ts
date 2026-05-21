// Thread sub-commands for the guildbot CLI. Plan 005 R5.
//
// Examples:
//   guildbot thread list
//   guildbot thread show <threadId>
//   guildbot thread new [--title "..."]
//   guildbot thread fork <threadId> --after <messageId> [--title "..."]
//   guildbot thread chat <threadId>
//
// All commands operate on the active guild dir (GUILDBOT_GUILD_DIR or
// --guild-dir <path>). They call straight into @guildbot/threads.

import readline from 'node:readline'
import { loadConfig, paths, renderGuildSystemMessage } from '@guildbot/guild-config'
import {
  appendMessage,
  createThread,
  forkThread,
  listThreads,
  loadThread,
  readMessages,
  ThreadNotFoundError,
  type ThreadMessage,
} from '@guildbot/threads'
import { agentLoop } from './agent/loop'
import { formatCompactionLog, runCompactionIfNeeded } from './compaction'

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

// ── thread list ─────────────────────────────────────────────────────────────

async function cmdThreadList(argv: Argv) {
  const guildId = getFlag(argv, 'guild')
  const threads = await listThreads(guildId ? { guildId } : undefined)
  if (threads.length === 0) {
    console.log('No threads.')
    return
  }
  for (const t of threads) {
    const title = t.title ?? '(no title)'
    console.log(`${t.id}  ${t.guildId}  ${t.updatedAt}  ${title}`)
  }
}

// ── thread show ─────────────────────────────────────────────────────────────

async function cmdThreadShow(argv: Argv) {
  const id = argv[0]
  if (!id) throw new Error('Usage: thread show <threadId>')
  const meta = await loadThread(id)
  const msgs = await readMessages(id)
  console.log(`# ${meta.title ?? '(no title)'}`)
  console.log(`id:        ${meta.id}`)
  console.log(`guild:     ${meta.guildId}`)
  console.log(`created:   ${meta.createdAt}`)
  console.log(`updated:   ${meta.updatedAt}`)
  if (meta.parent) {
    console.log(`parent:    ${meta.parent.threadId}@${meta.parent.forkedAfterMessageId}`)
  }
  console.log(`messages:  ${msgs.length}`)
  console.log('')
  for (const m of msgs) {
    const kindTag = m.kind ? ` [${m.kind}]` : ''
    const toolTag = m.toolName ? ` (tool:${m.toolName})` : ''
    console.log(`--- ${m.id}  ${m.role}${kindTag}${toolTag}`)
    console.log(m.content)
  }
}

// ── thread new ──────────────────────────────────────────────────────────────

async function cmdThreadNew(argv: Argv) {
  const guildId = getFlag(argv, 'guild') ?? loadConfig().guild.id
  const title = getFlag(argv, 'title')
  const rendered = await renderGuildSystemMessage()
  const meta = await createThread({
    guildId,
    title,
    systemContext: { guildSystemPromptSnapshotPath: rendered.snapshotPath },
  })
  if (rendered.content.trim()) {
    await appendMessage(meta.id, {
      role: 'system',
      kind: 'guild-prompt',
      content: rendered.content,
    })
  }
  console.log(meta.id)
}

// ── thread fork ─────────────────────────────────────────────────────────────

async function cmdThreadFork(argv: Argv) {
  const id = argv[0]
  if (!id) throw new Error('Usage: thread fork <threadId> --after <messageId> [--title "..."]')
  const afterMessageId = getFlag(argv, 'after')
  if (!afterMessageId) throw new Error('--after <messageId> is required')
  const title = getFlag(argv, 'title')
  const fork = await forkThread(id, afterMessageId, { title })
  console.log(fork.id)
}

// ── thread chat ─────────────────────────────────────────────────────────────

export type CliChatTurnResult = {
  answer: string
  compactionLine: string
}

/**
 * Single CLI chat turn. Exposed so tests can drive a synthetic turn without
 * stdin/readline. Returns the agent's answer plus the compaction log line
 * (empty when no compaction fired). The caller logs in user-visible order.
 */
export async function runCliChatTurn(
  id: string,
  input: string,
): Promise<CliChatTurnResult> {
  const meta = await loadThread(id)
  const history: ThreadMessage[] = await readMessages(id)
  await appendMessage(id, {
    role: 'user',
    content: input,
    sourceRef: { platform: 'cli', userId: process.env.USER ?? 'cli' },
  })

  const answer = await agentLoop({
    userMessage: input,
    conversationHistory: history,
    context: {
      guildId: meta.guildId,
      channelId: 'cli',
      userId: process.env.USER ?? 'cli',
      sessionDir: paths().sessions,
      threadId: id,
    } as any,
    model: loadConfig().llm.models.default,
    onMessage: async (m) => {
      await appendMessage(id, {
        role: m.role,
        content: m.content,
        toolName: m.toolName,
        toolCallId: m.toolCallId,
        toolCalls: m.toolCalls,
      })
    },
  })

  // Compaction after the agent loop's final assistant message — never mid-loop.
  let compactionLine = ''
  try {
    const compaction = await runCompactionIfNeeded(id)
    compactionLine = formatCompactionLog(id, compaction)
  } catch (e: any) {
    console.warn('[compaction] post-turn check failed:', e?.message ?? e)
  }
  return { answer, compactionLine }
}

async function cmdThreadChat(argv: Argv) {
  const id = argv[0]
  if (!id) throw new Error('Usage: thread chat <threadId>')
  const meta = await loadThread(id)
  console.log(`Chatting in thread ${meta.id} (${meta.title ?? '(no title)'})`)
  console.log('Type your message and press Enter. Ctrl+D or "exit" to quit.')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (prompt: string) =>
    new Promise<string | undefined>((resolve) => {
      rl.question(prompt, (answer) => resolve(answer))
      rl.once('close', () => resolve(undefined))
    })

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const input = (await ask('> '))?.trim()
      if (!input || input === 'exit' || input === 'quit') break
      try {
        const { answer, compactionLine } = await runCliChatTurn(id, input)
        console.log(answer)
        if (compactionLine) console.log(compactionLine)
      } catch (e: any) {
        console.error('Error:', e?.message ?? e)
      }
    }
  } finally {
    rl.close()
  }
}

// ── dispatcher ──────────────────────────────────────────────────────────────

export async function cmdThread(rawArgv: Argv) {
  const argv = applyGuildDirFlag(rawArgv)
  const sub = argv[0]
  const rest = argv.slice(1)
  try {
    if (sub === 'list') return await cmdThreadList(rest)
    if (sub === 'show') return await cmdThreadShow(rest)
    if (sub === 'new') return await cmdThreadNew(rest)
    if (sub === 'fork') return await cmdThreadFork(rest)
    if (sub === 'chat') return await cmdThreadChat(rest)
    console.log('Usage: guildbot thread <list|show|new|fork|chat> [args]')
    console.log('  list                                — list threads in this guild')
    console.log('  show <threadId>                     — dump a thread')
    console.log('  new [--guild <id>] [--title "..."]  — create an empty thread, print id')
    console.log('  fork <threadId> --after <messageId> — fork from a message')
    console.log('  chat <threadId>                     — interactive REPL')
    console.log('  --guild-dir <path>                  — operate on a specific guild dir')
    process.exit(1)
  } catch (e: any) {
    if (e instanceof ThreadNotFoundError) {
      console.error(`Thread not found: ${e.threadId}`)
      process.exit(1)
    }
    throw e
  }
}
