import {
  ApplicationCommandDataResolvable,
  ApplicationCommandOptionType,
  AttachmentBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
  Message,
  Partials,
  PermissionFlagsBits,
  TextBasedChannel,
  TextChannel
} from 'discord.js'

import fs from 'fs/promises'
import { join } from 'node:path'
import {
  diffAgainstDefault,
  forgetMemory,
  initGuildDir,
  listHistory,
  loadConfig,
  loadMemory,
  loadPrompt,
  paths,
  renderGuildSystemMessage,
  resolveGuildDir,
  revert as revertPromptOrMemory,
  updateMemory,
  updatePrompt,
} from '@guildbot/guild-config'
import { structured } from '@guildbot/llm'
import { z } from 'zod'
import {
  ensureSession,
  formatAttachmentsForPrompt,
  saveMessageAttachments
} from './askQuestion'
import {
  appendMessage,
  createThread,
  readMessages,
  type ThreadMessage,
} from '@guildbot/threads'
import { bindDiscord, resolveDiscord } from '@guildbot/discord-index'
import { audioToTranscript, transcriptToDiagrams } from '@guildbot/media'
import type { CldGenerator } from '@guildbot/media'
import * as db from '@guildbot/database'
import { getActiveRecording, startRecording, stopRecording } from '@guildbot/recording'
import { startTranscriptionServer } from '@guildbot/recording'
import * as messageProcessor from '@guildbot/message-processor'
import * as ragService from '@guildbot/rag'
import { agentLoop } from './agent/loop'
import { loadToolHandler } from './tools/discover'
import { evaluateOperatorGate } from './operatorGate'
import { formatCompactionLog, runCompactionIfNeeded } from './compaction'

// Resolve the active guild dir and ensure it is seeded (data subdirs, tools, skills,
// prompt.md, memory.md). config.json + secrets.json must already exist; the loader
// fails loudly otherwise. initGuildDir resyncs tools/ + skills/ from the codebase
// on every startup so the per-guild copies stay current with code changes.
const GUILD_DIR = resolveGuildDir()
if (!process.env.VITEST) {
  initGuildDir(GUILD_DIR, { codebaseRoot: join(import.meta.dirname, '..') })
  console.log(`[startup] resynced tools/ + skills/ from codebase into ${GUILD_DIR}`)
}

// initial config read — logs startup-only fields and surfaces validation errors early
const STARTUP_CONFIG = process.env.VITEST ? null : loadConfig(GUILD_DIR)
if (STARTUP_CONFIG) {
  console.log(
    `[startup] guildDir=${GUILD_DIR} guild=${STARTUP_CONFIG.guild.name} ` +
      `discord.applicationId=${STARTUP_CONFIG.discord.applicationId ?? '<unset>'} ` +
      `(token + applicationId are startup-only — restart required if edited)`,
  )
}

const RECORDINGS_ROOT = paths(GUILD_DIR).recordings

db.initDB().catch(console.error)

const findRecordingById = async (recordingId?: string) => {
  if (!recordingId) return undefined
  const vttPath = join(RECORDINGS_ROOT, recordingId, 'audio.vtt')
  try {
    await fs.stat(vttPath)
    return { recordingId, vttPath }
  } catch {
    return undefined
  }
}

const findLatestRecordingForChannel = async (channelId: string) => {
  try {
    const entries = await fs.readdir(RECORDINGS_ROOT, { withFileTypes: true })
    const candidates = await Promise.all(
      entries
        .filter((d) => d.isDirectory() && d.name.startsWith(`${channelId}-`))
        .map(async (d) => {
          const vttPath = join(RECORDINGS_ROOT, d.name, 'audio.vtt')
          try {
            const stat = await fs.stat(vttPath)
            return { recordingId: d.name, vttPath, mtimeMs: stat.mtimeMs }
          } catch {
            return null
          }
        })
    )
    const valid = candidates.filter(Boolean) as { recordingId: string; vttPath: string; mtimeMs: number }[]
    if (!valid.length) return undefined
    valid.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return { recordingId: valid[0].recordingId, vttPath: valid[0].vttPath }
  } catch {
    return undefined
  }
}

const resolveRecordingReference = async (channelId: string, opts: { meetingId?: string }) => {
  const direct = await findRecordingById(opts.meetingId)
  if (direct) return direct
  return findLatestRecordingForChannel(channelId)
}

export const vttToTranscriptLines = (vtt: string) => {
  const lines = vtt.split(/\r?\n/)
  const cleaned: string[] = []
  for (const line of lines) {
    if (!line || line.startsWith('WEBVTT')) continue
    if (line.includes('-->')) continue
    if (/^\d+$/.test(line.trim())) continue
    const stripped = line
      .replace(/<v\s+[^>]+>/gi, '')
      .replace(/<\/v>/gi, '')
      .trim()
    if (stripped) cleaned.push(stripped)
  }
  return cleaned
}

const formatMeetingDigest = (digest: any) => {
  const lines: string[] = []

  const pushSection = (title: string, entries: any[] | undefined, render: (e: any, idx: number) => string) => {
    lines.push(`**${title}**`)
    if (!entries || !entries.length) {
      lines.push('- none')
      lines.push('')
      return
    }
    entries.forEach((entry, idx) => {
      const rendered = render(entry, idx)
      if (rendered) lines.push(rendered)
    })
    lines.push('')
  }

  pushSection('Insights', digest?.insights, (e) => {
    const evidence = Array.isArray(e?.evidence) && e.evidence.length ? ` — evidence: ${e.evidence.join('; ')}` : ''
    return `- ${e?.summary ?? ''}${evidence}`.trim()
  })

  pushSection('Action items', digest?.actionItems, (e) => {
    const bits = [e?.owner && `owner: ${e.owner}`, e?.due && `due: ${e.due}`, e?.status && `status: ${e.status}`]
    const meta = bits.filter(Boolean).join('; ')
    const suffix = meta ? ` (${meta})` : ''
    return `- ${e?.task ?? ''}${suffix}`.trim()
  })

  pushSection('Decisions', digest?.decisions, (e) => {
    const rationale = e?.rationale ? ` — rationale: ${e.rationale}` : ''
    return `- ${e?.decision ?? ''}${rationale}`.trim()
  })

  pushSection('Open questions', digest?.openQuestions, (e) => {
    const owner = e?.owner ? ` (owner: ${e.owner})` : ''
    return `- ${e?.question ?? ''}${owner}`.trim()
  })

  // trim trailing blank lines
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}

async function findReferencedMessage(message: Message) {
  if (message.reference?.messageId) {
    try {
      return await message.fetchReference()
    } catch (e) {
      console.warn('Failed to fetch referenced message', e)
    }
  }
  if (message.channel?.isThread?.()) {
    try {
      return await message.channel.fetchStarterMessage()
    } catch (e) {
      console.warn('Failed to fetch thread starter message', e)
    }
  }
  return undefined
}

const DISCORD_TOKEN = STARTUP_CONFIG?.discord.token

if (!DISCORD_TOKEN && !process.env.VITEST) {
  console.error('Missing discord.token in guild config (secrets.json)')
  process.exit(1)
}
if (!STARTUP_CONFIG?.llm.baseUrl && !process.env.VITEST) {
  console.error('Missing llm.baseUrl in guild config (config.json)')
  process.exit(1)
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
})

client.on('messageDelete', async (message) => {
  if (message.id) {
    try {
      await messageProcessor.deleteMessage(message.id)
      console.log(`Deleted message ${message.id} from DB`)
    } catch (e) {
      console.error('Failed to handle message delete', e)
    }
  }
})

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`)

  try {
    await startTranscriptionServer()
  } catch (e) {
    console.warn('Transcription server failed to start', e)
  }

  try {
    const guildId = loadConfig().discord.registerCommandsInGuildId
    if (guildId && client.application?.commands) {
      const commands: ApplicationCommandDataResolvable[] = [
        {
          name: 'record',
          description: 'Record the current voice channel',
          options: [
            {
              name: 'start',
              description: 'Start recording the current voice channel',
              type: ApplicationCommandOptionType.Subcommand,
              options: [
                {
                  name: 'include_audio',
                  description: 'Persist speaker .wav files (default: off)',
                  type: ApplicationCommandOptionType.Boolean,
                  required: false
                }
              ]
            },
            {
              name: 'stop',
              description: 'Stop the active recording',
              type: ApplicationCommandOptionType.Subcommand
            },
            {
              name: 'review',
              description: 'Summarise a recording (insights, actions, decisions, questions)',
              type: ApplicationCommandOptionType.Subcommand,
              options: [
                {
                  name: 'meeting_id',
                  description: 'Recording ID (defaults to latest in this channel)',
                  type: ApplicationCommandOptionType.String,
                  required: false
                },
                {
                  name: 'prompt',
                  description: 'Extra guidance for the meeting digest',
                  type: ApplicationCommandOptionType.String,
                  required: false
                }
              ]
            }
          ]
        },
        {
          name: 'diagram',
          description: 'Turn an audio file into a diagram',
          options: [
            {
              name: 'audio',
              description: 'The audio file to analyze',
              type: ApplicationCommandOptionType.Attachment, // ATTACHMENT
              required: false
            },
            {
              name: 'url',
              description: 'A URL to an audio file to analyze',
              type: ApplicationCommandOptionType.String, // STRING
              required: false
            },
            {
              name: 'prompt',
              description: 'An additional user prompt to guide diagram generation',
              type: ApplicationCommandOptionType.String, // STRING
              required: false
            },
            {
              name: 'regenerate',
              description: 'Force re-generation of diagrams',
              type: ApplicationCommandOptionType.Boolean, // BOOLEAN
              required: false
            }
          ]
        },
        {
          name: 'guild',
          description: 'Guild knowledge commands',
          options: [
            {
              name: 'search',
              description: 'Search message history',
              type: ApplicationCommandOptionType.Subcommand,
              options: [
                {
                  name: 'query',
                  description: 'Search terms',
                  type: ApplicationCommandOptionType.String,
                  required: true
                }
              ]
            },
            {
              name: 'tag',
              description: 'Tag a message',
              type: ApplicationCommandOptionType.Subcommand,
              options: [
                {
                  name: 'tags',
                  description: 'Comma separated tags',
                  type: ApplicationCommandOptionType.String,
                  required: true
                },
                {
                  name: 'message',
                  description: 'The message content, ID, or Link to tag',
                  type: ApplicationCommandOptionType.String,
                  required: false
                },
                {
                  name: 'remove',
                  description: 'Remove these tags instead of adding them',
                  type: ApplicationCommandOptionType.Boolean,
                  required: false
                }
              ]
            },
            {
              name: 'ask',
              description: 'Ask a question based on history',
              type: ApplicationCommandOptionType.Subcommand,
              options: [
                { name: 'question', description: 'Question', type: ApplicationCommandOptionType.String, required: true }
              ]
            },
            {
              name: 'prompt',
              description: 'Manage the guild system prompt (operators only)',
              type: ApplicationCommandOptionType.SubcommandGroup,
              options: [
                {
                  name: 'show',
                  description: 'Show the current prompt',
                  type: ApplicationCommandOptionType.Subcommand,
                },
                {
                  name: 'set',
                  description: 'Set the prompt body (inline text or uploaded file)',
                  type: ApplicationCommandOptionType.Subcommand,
                  options: [
                    {
                      name: 'body',
                      description: 'Inline body (use file for long content)',
                      type: ApplicationCommandOptionType.String,
                      required: false,
                    },
                    {
                      name: 'file',
                      description: 'Markdown file to use as the body',
                      type: ApplicationCommandOptionType.Attachment,
                      required: false,
                    },
                  ],
                },
                {
                  name: 'history',
                  description: 'List prior prompt versions',
                  type: ApplicationCommandOptionType.Subcommand,
                },
                {
                  name: 'revert',
                  description: 'Revert prompt to a prior version',
                  type: ApplicationCommandOptionType.Subcommand,
                  options: [
                    {
                      name: 'timestamp',
                      description: 'Timestamp (or filename) from history',
                      type: ApplicationCommandOptionType.String,
                      required: true,
                    },
                  ],
                },
                {
                  name: 'diff',
                  description: 'Show diff against the bundled default',
                  type: ApplicationCommandOptionType.Subcommand,
                },
              ],
            },
            {
              name: 'memory',
              description: 'Manage the guild long-term memory (operators only)',
              type: ApplicationCommandOptionType.SubcommandGroup,
              options: [
                {
                  name: 'show',
                  description: 'Show the current memory',
                  type: ApplicationCommandOptionType.Subcommand,
                },
                {
                  name: 'set',
                  description: 'Set the memory body (inline text or uploaded file)',
                  type: ApplicationCommandOptionType.Subcommand,
                  options: [
                    {
                      name: 'body',
                      description: 'Inline body (use file for long content)',
                      type: ApplicationCommandOptionType.String,
                      required: false,
                    },
                    {
                      name: 'file',
                      description: 'Markdown file to use as the body',
                      type: ApplicationCommandOptionType.Attachment,
                      required: false,
                    },
                  ],
                },
                {
                  name: 'history',
                  description: 'List prior memory versions',
                  type: ApplicationCommandOptionType.Subcommand,
                },
                {
                  name: 'revert',
                  description: 'Revert memory to a prior version',
                  type: ApplicationCommandOptionType.Subcommand,
                  options: [
                    {
                      name: 'timestamp',
                      description: 'Timestamp (or filename) from history',
                      type: ApplicationCommandOptionType.String,
                      required: true,
                    },
                  ],
                },
                {
                  name: 'forget',
                  description: 'LLM-assisted removal of memory matching a natural-language pattern',
                  type: ApplicationCommandOptionType.Subcommand,
                  options: [
                    {
                      name: 'pattern',
                      description: 'Natural-language description of what to forget',
                      type: ApplicationCommandOptionType.String,
                      required: true,
                    },
                  ],
                },
                {
                  name: 'diff',
                  description: 'Show diff against the bundled default',
                  type: ApplicationCommandOptionType.Subcommand,
                },
              ],
            },
          ]
        }
      ]
      await client.guilds.resolve(guildId as string)?.commands.set(commands)
      console.log('Registered slash commands in guild', guildId)

      // Sync history on startup
      const guild = client.guilds.resolve(guildId as string)
      if (guild) {
        console.log('Syncing channel history...')
        const channels = await guild.channels.fetch()
        for (const [id, channel] of channels) {
          if (channel && channel.isTextBased()) {
            await messageProcessor
              .syncChannel(channel as TextBasedChannel)
              .catch((e) => console.error(`Failed to sync channel ${id}`, e))
          }
        }
        console.log('History sync complete.')

        console.log('Syncing transcriptions...')
        try {
          const entries = await fs.readdir(RECORDINGS_ROOT, { withFileTypes: true })
          for (const dir of entries) {
            if (!dir.isDirectory()) continue
            const recordingId = dir.name
            const channelId = recordingId.split('-')[0] // Assuming CHANNELID-TIMESTAMP format
            const vttPath = join(RECORDINGS_ROOT, recordingId, 'audio.vtt')

            try {
              await fs.stat(vttPath)
              const vttContent = await fs.readFile(vttPath, 'utf-8')
              const lines = vttToTranscriptLines(vttContent)
              const fullTranscript = lines.join('\n')

              if (fullTranscript.trim()) {
                // Use folder timestamp?
                // recordingId format: channelId-TIMESTAMP
                // TIMESTAMP is ISO-like but replaced chars.
                // Actually src/recording/discord.ts: utcStamp() -> iso with replaced chars.
                // Let's rely on file mtime or try to parse string.
                // Simpler: use file mtime.
                const stat = await fs.stat(vttPath)

                await messageProcessor.processMessage(
                  {
                    id: recordingId,
                    guildId: guildId as string,
                    channelId: channelId,
                    authorId: 'system', // or 'transcription'
                    content: fullTranscript,
                    createdTimestamp: stat.mtimeMs,
                    type: 'transcription'
                  },
                  true
                )
              }
            } catch {
              // No vtt or error reading
            }
          }
          console.log('Transcription sync complete.')
        } catch (e) {
          console.error('Failed to sync transcriptions', e)
        }
      }
    }
  } catch (err) {
    console.warn('Failed to register commands', err)
  }
})

// We no longer expose a free-text prefix command. Interactions only.

/**
 * Discord interaction tokens expire 15 minutes after the interaction is
 * created. Long-running flows (e.g. transcribing a big call before /record
 * stop replies) blow past that and `editReply` throws `DiscordAPIError[50027]
 * Invalid Webhook Token`. When that happens, fall back to posting the payload
 * to the originating channel directly so the user still sees the result.
 *
 * Returns true if the user was reached (via editReply or channel.send),
 * false if neither worked.
 */
async function safeInteractionReply(
  chat: ChatInputCommandInteraction,
  payload: any,
): Promise<boolean> {
  try {
    await chat.editReply(payload)
    return true
  } catch (e: any) {
    const tokenExpired = e?.code === 50027 || /Invalid Webhook Token/i.test(e?.message ?? '')
    if (!tokenExpired) {
      console.warn('[safeInteractionReply] editReply failed (non-token)', e)
    }
    const channel: any = chat.channel
    if (channel && typeof channel.send === 'function') {
      try {
        await channel.send(payload)
        return true
      } catch (e2) {
        console.error('[safeInteractionReply] channel.send fallback failed', e2)
      }
    }
    return false
  }
}

/**
 * Operator gate. Members with role IDs in config.memory.operatorRoleIds are
 * allowed. When that list is empty, only Discord guild administrators are
 * allowed. Returns { ok: true } when authorised; otherwise an error message
 * that should be shown to the user.
 */
function checkOperatorGate(chat: ChatInputCommandInteraction):
  | { ok: true }
  | { ok: false; reason: string } {
  const member: any = chat.member
  if (!member) return { ok: false, reason: 'This command must be used inside a guild.' }

  const perms = member.permissions
  const isAdministrator =
    perms && typeof perms.has === 'function'
      ? perms.has(PermissionFlagsBits.Administrator)
      : false

  const memberRoleIds: string[] = (() => {
    const r = member.roles
    if (!r) return []
    if (Array.isArray(r)) return r as string[]
    if (typeof r.cache?.keys === 'function') return Array.from(r.cache.keys()) as string[]
    return []
  })()

  return evaluateOperatorGate({
    memberRoleIds,
    isAdministrator,
    operatorRoleIds: loadConfig().memory.operatorRoleIds,
  })
}

async function readAttachmentBody(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to download attachment: HTTP ${res.status}`)
  }
  return res.text()
}

const FORGET_SCHEMA = z.object({
  rewrittenMemory: z.string(),
  removed: z.array(z.string()),
})

async function handlePromptOrMemoryCommand(
  chat: ChatInputCommandInteraction,
  group: 'prompt' | 'memory',
  sub: string,
): Promise<void> {
  const isMutating = sub !== 'show' && sub !== 'history' && sub !== 'diff'

  if (isMutating) {
    const gate = checkOperatorGate(chat)
    if (!gate.ok) {
      await chat.editReply(gate.reason)
      return
    }
  }

  if (sub === 'show') {
    const v = group === 'prompt' ? await loadPrompt() : await loadMemory()
    const header = `**${group}** (v${v.version}, updated ${v.updatedAt})`
    const body = v.content.trim() ? v.content : '(empty)'
    const payload = `${header}\n\n${body}`
    if (payload.length > 1900) {
      const att = new AttachmentBuilder(Buffer.from(payload, 'utf8'), {
        name: `${group}.md`,
      })
      await chat.editReply({ content: header, files: [att] })
    } else {
      await chat.editReply(payload)
    }
    return
  }

  if (sub === 'history') {
    const entries = listHistory(group)
    if (entries.length === 0) {
      await chat.editReply(`No ${group} history entries yet.`)
      return
    }
    const lines = entries
      .slice(0, 20)
      .map((e) => `• \`${e.filename}\` — ${e.timestamp || '?'} — ${e.reason} (${e.size} bytes)`)
    const more = entries.length > 20 ? `\n…and ${entries.length - 20} more` : ''
    await chat.editReply(`Recent ${group} history:\n${lines.join('\n')}${more}`)
    return
  }

  if (sub === 'diff') {
    const diff = await diffAgainstDefault(group)
    if (!diff) {
      await chat.editReply(`${group}.md matches the bundled default.`)
      return
    }
    if (diff.length > 1900) {
      await chat.editReply({
        content: `Diff vs bundled default:`,
        files: [new AttachmentBuilder(Buffer.from(diff, 'utf8'), { name: `${group}.diff` })],
      })
    } else {
      await chat.editReply(`Diff vs bundled default:\n\`\`\`diff\n${diff}\n\`\`\``)
    }
    return
  }

  if (sub === 'set') {
    const inline = chat.options.getString('body', false) ?? undefined
    const attachment = chat.options.getAttachment('file', false)
    let body: string | undefined
    if (attachment) {
      body = await readAttachmentBody(attachment.url)
    } else if (inline) {
      body = inline
    }
    if (!body) {
      await chat.editReply('Provide either `body` or a markdown `file` attachment.')
      return
    }
    const reason = `operator:${chat.user.id}`
    try {
      const result =
        group === 'prompt'
          ? await updatePrompt(body, { reason })
          : await updateMemory(body, { reason })
      await chat.editReply(`Updated ${group}.md to v${result.version}.`)
    } catch (e: any) {
      await chat.editReply(`Rejected: ${e?.message ?? e}`)
    }
    return
  }

  if (sub === 'revert') {
    const target = chat.options.getString('timestamp', true)
    try {
      const result = await revertPromptOrMemory(
        group,
        target,
        `operator:${chat.user.id}`,
      )
      await chat.editReply(
        `Reverted ${group}.md to history entry "${target}". Now v${result.version}.`,
      )
    } catch (e: any) {
      await chat.editReply(`Revert failed: ${e?.message ?? e}`)
    }
    return
  }

  if (sub === 'forget' && group === 'memory') {
    const pattern = chat.options.getString('pattern', true)
    try {
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
          if (!r.success) {
            throw new Error(`LLM forget failed: ${r.error}`)
          }
          return r.data
        },
      })
      const removedSummary =
        result.removed.length === 0
          ? 'No matching entries found.'
          : `Removed ${result.removed.length} entries.`
      await chat.editReply(
        `Memory forget applied — now v${result.after.version}. ${removedSummary}`,
      )
    } catch (e: any) {
      await chat.editReply(`Forget failed: ${e?.message ?? e}`)
    }
    return
  }

  await chat.editReply(`Unknown subcommand: ${group} ${sub}`)
}

export async function handleInteraction(interaction: Interaction) {
  try {
    await handleInteractionInner(interaction)
  } catch (err) {
    // Any error escaping the inner handler is routed by discord.js to the
    // Client's 'error' event, which has no default listener and crashes the
    // process. Catch + log instead. Individual command branches own their own
    // user-facing failure messaging.
    console.error('[handleInteraction] unhandled error:', err)
  }
}

async function handleInteractionInner(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return
  const chat = interaction as ChatInputCommandInteraction

  if (chat.commandName === 'guild') {
    const group = chat.options.getSubcommandGroup(false)
    const sub = chat.options.getSubcommand()
    await chat.deferReply()

    if (group === 'prompt' || group === 'memory') {
      try {
        await handlePromptOrMemoryCommand(chat, group, sub)
      } catch (e: any) {
        await chat.editReply(`Error: ${e?.message ?? e}`)
      }
      return
    }

    try {
      if (sub === 'search') {
        const query = chat.options.getString('query', true)
        const results = await ragService.search(chat.guildId!, query)
        if (results.length === 0) {
          await chat.editReply('No results found.')
          return
        }
        const formatResult = (r: any) => {
          const link = `https://discord.com/channels/${r.guild_id}/${r.channel_id}/${r.id}`
          const content = r.content || ''
          const lines = content.split('\n').filter(Boolean)
          const hasMoreLines = lines.length > 2
          const snippet = lines.slice(0, 2).join('\n')
          const snip = snippet.length > 200
          const snippetShortened = snip ? snippet.substring(0, 197) : snippet
          const more = snip || hasMoreLines ? '...' : ''
          return `${link}\n${snippetShortened}${more}`
        }

        const lines = results.map(formatResult)
        const fullResponse = lines.join('\n')

        if (fullResponse.length > 2000) {
          await chat.editReply('Found many results. Creating a thread for details...')
          const replyMsg = await chat.fetchReply()
          if (replyMsg) {
            try {
              const thread = await replyMsg.startThread({
                name: `Search: ${query.length > 20 ? query.substring(0, 20) + '...' : query}`,
                autoArchiveDuration: 60
              })

              let currentChunk = ''
              for (const line of lines) {
                if (line.length > 2000) {
                  // If a single line is too long, send current chunk, then split line
                  if (currentChunk) {
                    await thread.send(currentChunk)
                    currentChunk = ''
                  }
                  // Split long line
                  for (let i = 0; i < line.length; i += 2000) {
                    await thread.send(line.substring(i, i + 2000))
                  }
                } else if ((currentChunk + '\n' + line).length > 2000) {
                  await thread.send(currentChunk)
                  currentChunk = line
                } else {
                  currentChunk = currentChunk ? currentChunk + '\n' + line : line
                }
              }
              if (currentChunk) {
                await thread.send(currentChunk)
              }
            } catch (err: any) {
              console.error('Failed to create thread', err)
              await chat.followUp({ content: `Failed to create thread: ${err.message}`, ephemeral: true })
            }
          }
        } else {
          await chat.editReply(fullResponse)
        }
      } else if (sub === 'tag') {
        const messageArg = chat.options.getString('message', false)
        const tagsArg = chat.options.getString('tags', true)
        const removeFn = chat.options.getBoolean('remove', false)
        const tags = tagsArg
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)

        let targetMessageId: string | null = null
        let isContent = false

        if (messageArg) {
          const linkMatch = messageArg.match(/https:\/\/discord\.com\/channels\/\d+\/\d+\/(\d+)/)
          const idMatch = messageArg.match(/^\d+$/)
          if (linkMatch) {
            targetMessageId = linkMatch[1]
          } else if (idMatch) {
            targetMessageId = idMatch[0]
          } else {
            isContent = true
          }
        } else {
          // No message argument = Tag the latest non-bot message in the channel
          try {
            const messages = await chat.channel?.messages.fetch({ limit: 5 })
            const last = messages?.find((m) => !m.author.bot)
            if (last) {
              targetMessageId = last.id
              await messageProcessor.processDiscordMessage(last)
            }
          } catch (e) {
            console.warn('Failed to fetch latest message', e)
          }
        }

        const action = removeFn ? 'Untagged' : 'Tagged'

        if (isContent && messageArg) {
          // User provided content to save and tag
          const newId = chat.id
          await messageProcessor.processMessage({
            id: newId,
            guildId: chat.guildId,
            channelId: chat.channelId,
            authorId: chat.user.id,
            content: messageArg,
            createdTimestamp: chat.createdTimestamp,
            type: 'user-tagged'
          })

          if (removeFn) {
            await messageProcessor.removeTags(newId, tags)
          } else {
            await messageProcessor.addTags(newId, tags)
          }
          await chat.editReply(`Saved and ${action.toLowerCase()} content with: ${tags.join(', ')}`)
        } else if (targetMessageId) {
          // Tagging an existing message (ID, Link, or Latest)
          try {
            if (removeFn) {
              await messageProcessor.removeTags(targetMessageId, tags)
            } else {
              await messageProcessor.addTags(targetMessageId, tags)
            }
            await chat.editReply(`${action} message ${targetMessageId} with: ${tags.join(', ')}`)
          } catch (e: any) {
            if (e.message === 'Message not found') {
              // Try to sync if explicit ID was given (skip for latest as we just fetched it)
              if (messageArg) {
                // Was explicit
                try {
                  let channelId = chat.channelId
                  // If link, extract channel
                  if (messageArg.includes('https://')) {
                    const match = messageArg.match(/channels\/\d+\/(\d+)\//)
                    if (match) channelId = match[1]
                  }

                  const channel = (await chat.guild?.channels.fetch(channelId)) as TextBasedChannel
                  if (channel && channel.isTextBased()) {
                    const msg = await channel.messages.fetch(targetMessageId)
                    if (msg) {
                      await messageProcessor.processDiscordMessage(msg)
                      if (removeFn) {
                        await messageProcessor.removeTags(targetMessageId, tags)
                      } else {
                        await messageProcessor.addTags(targetMessageId, tags)
                      }
                      await chat.editReply(
                        `Synced and ${action.toLowerCase()} message ${targetMessageId} with: ${tags.join(', ')}`
                      )
                      return
                    }
                  }
                } catch (err) {
                  console.warn('Failed to fetch/sync for tagging', err)
                }
              }
            }
            await chat.editReply(`Failed to tag message: ${e.message}`)
          }
        } else {
          await chat.editReply('Could not determine message to tag.')
        }
      } else if (sub === 'ask') {
        const question = chat.options.getString('question', true)
        const answer = await ragService.ask(chat.guildId!, question)
        if (answer.length > 2000) {
          const att = new AttachmentBuilder(Buffer.from(answer, 'utf-8'), { name: `answer.txt` })
          await chat.editReply({ content: 'Answer:', files: [att] })
        } else {
          await chat.editReply(answer)
        }
      }
    } catch (e: any) {
      await chat.editReply(`Error: ${e.message}`)
    }
    return
  }

  if (chat.commandName === 'diagram') {
    const attachment = chat.options.getAttachment('audio', false)

    await chat.deferReply()

    // get the URL of the attachment, falling back to pulling a link from the message text
    const url = attachment?.url ?? chat.toString().match(/https?:\/\/\S+/)?.[0]

    if (!url) {
      return chat.editReply('Please provide an audio file attachment or a URL link to an audio file.')
    }

    const regenerate = chat.options.getBoolean('regenerate', false) ?? false
    const userPrompt = chat.options.getString('prompt', false) ?? undefined

    try {
      const onProgress = async (message: string) => {
        try {
          await chat.editReply({ content: `🔄 ${message}` })
        } catch (e) {
          console.warn('onProgress editReply failed', e)
        }
      }

      const id = await audioToTranscript(url, onProgress)
      const cldGenerator: CldGenerator = async (sentences, prompt) => {
        const cldHandler = await loadToolHandler('extract-causal-relationships')
        const cldResult = await cldHandler(
          { text: sentences.join('\n'), prompt },
          { guildId: chat.guildId ?? undefined, channelId: chat.channelId, userId: chat.user.id }
        )
        if (!cldResult.success) return { error: (cldResult.data as any)?.error ?? 'CLD extraction failed' }
        return cldResult.data as any
      }
      const { kumuPath, pngPath } = await transcriptToDiagrams(
        id,
        undefined,
        userPrompt,
        onProgress,
        regenerate,
        cldGenerator,
      )
      const diagramData = await fs.readFile(kumuPath, 'utf-8')
      const pngData = await fs.readFile(pngPath)
      return chat.editReply({
        content: 'Here is your diagram for ' + url,
        files: [
          new AttachmentBuilder(Buffer.from(diagramData), { name: 'kumu.json' }),
          new AttachmentBuilder(pngData, { name: 'diagram.png' })
        ]
      })
    } catch (err: any) {
      console.error('diagram handler error', err)
      return chat.editReply({
        content: `Error calling audioToDiagram: ${err?.message ?? String(err)}`
      })
    }
  }

  if (chat.commandName === 'record') {
    const sub = chat.options.getSubcommand(true)
    const guild = chat.guild
    if (!guild) return chat.reply({ content: 'This command is only available in servers.', ephemeral: true })

    if (sub === 'review') {
      const meetingId = chat.options.getString('meeting_id', false) ?? undefined
      const prompt = chat.options.getString('prompt', false) ?? undefined

      await chat.deferReply()

      const resolved = await resolveRecordingReference(chat.channelId, { meetingId })
      if (!resolved) {
        return chat.editReply(
          'No recordings found for this channel yet. Run /record start to capture one, then try again.'
        )
      }

      let vtt: string
      try {
        vtt = await fs.readFile(resolved.vttPath, 'utf-8')
      } catch (e: any) {
        return chat.editReply({
          content: `Could not read transcript for recording ${resolved.recordingId}: ${e?.message ?? e}`
        })
      }

      const transcriptLines = vttToTranscriptLines(vtt)
      if (!transcriptLines.length) {
        return chat.editReply('Transcript is empty or could not be parsed.')
      }

      try {
        const handler = await loadToolHandler('generate-meeting-digest')
        const result = await handler(
          { transcript_lines: transcriptLines, prompt },
          { guildId: chat.guildId ?? undefined, channelId: chat.channelId, userId: chat.user.id }
        )
        if (!result.success) {
          return chat.editReply({ content: `Failed to generate meeting digest: ${(result.data as any)?.error ?? 'unknown error'}` })
        }
        const digest = result.data

        const formatted = formatMeetingDigest(digest)

        if (formatted.length < 2000) {
          return chat.editReply({ content: formatted })
        }

        const attachment = new AttachmentBuilder(Buffer.from(formatted, 'utf-8'), {
          name: `meeting-digest-${resolved.recordingId}.txt`
        })

        return chat.editReply({
          content: `Here is your meeting digest:`,
          files: [attachment]
        })
      } catch (e: any) {
        return chat.editReply({ content: `Failed to generate meeting digest: ${e?.message ?? e}` })
      }
    }

    // Must be a text channel and member must be in a voice channel
    const member: any = chat.member
    const voiceCh = member?.voice?.channel
    if (!voiceCh) return chat.reply({ content: 'Join a voice channel first.', ephemeral: true })

    if (sub === 'start') {
      if (getActiveRecording(guild.id)) {
        return chat.reply({ content: 'A recording is already active in this server.', ephemeral: true })
      }
      try {
        await chat.deferReply()
        const includeAudio = chat.options.getBoolean('include_audio', false) ?? false
        const sess = await startRecording(guild.id, voiceCh, includeAudio, chat.channelId)
        return chat.editReply(`🎙️ Recording started. ID: ${sess.recordingId}`)
      } catch (e: any) {
        try {
          await chat.editReply({ content: `Failed to start recording: ${e?.message ?? e}` })
        } catch {
          try {
            await chat.followUp({ content: `Failed to start recording: ${e?.message ?? e}`, ephemeral: true })
          } catch {}
        }
        return
      }
    }

    if (sub === 'stop') {
      try {
        await chat.deferReply()
        const active = getActiveRecording(guild.id)
        const recordingId = active?.recordingId
        type SendableTextChannel = Extract<TextBasedChannel, { send: unknown }>

        const fetchTextChannel = async (channelId?: string | null): Promise<TextBasedChannel | null> => {
          if (!channelId) return null
          try {
            const channel = await client.channels.fetch(channelId)
            if (channel && channel.isTextBased()) return channel
          } catch (e) {
            console.warn('Failed to fetch transcript channel', e)
          }
          return null
        }

        const ensureSendableChannel = (channel: TextBasedChannel | null): channel is SendableTextChannel => {
          if (!channel) return false
          return 'send' in channel && typeof (channel as SendableTextChannel).send === 'function'
        }
        // Send immediate feedback that we are still transcribing remaining chunks
        await chat.editReply(
          recordingId
            ? `⏹️ Recording stopped (ID: ${recordingId}). Transcribing remaining audio…`
            : '⏹️ Recording stopped. Transcribing remaining audio…'
        )

        const sess = await stopRecording(guild.id)

        if (!sess.vttPath) {
          await safeInteractionReply(chat, 'Recording was cancelled or did not produce any audio.')
          return
        }

        const transcriptChannel =
          (await fetchTextChannel(loadConfig().discord.recordingTranscriptChannelId ?? undefined)) ||
          (await fetchTextChannel(sess.textChannelId ?? active?.textChannelId)) ||
          chat.channel

        if (!ensureSendableChannel(transcriptChannel)) {
          await safeInteractionReply(chat, { content: 'Failed to find a text channel to post the transcript.' })
          return
        }

        const vtt = await fs.readFile(sess.vttPath)
        const transcriptPayload = {
          content: `✅ Transcript ready (ID: ${sess.recordingId}).`,
          files: [new AttachmentBuilder(Buffer.from(vtt), { name: 'audio.vtt' })]
        }

        if (transcriptChannel.id === chat.channelId) {
          // editReply will likely fail if transcription took >15 min; safeInteractionReply
          // falls back to channel.send so the user still gets the VTT.
          await safeInteractionReply(chat, transcriptPayload)
        } else {
          await safeInteractionReply(chat, {
            content: `✅ Transcript ready (ID: ${sess.recordingId}). Posted to <#${transcriptChannel.id}>.`
          })
          try {
            await transcriptChannel.send(transcriptPayload)
          } catch (e: any) {
            await safeInteractionReply(chat, {
              content: `❌ Failed to post transcript to <#${transcriptChannel.id}>: ${e?.message ?? e}`
            })
            return
          }
        }
        /*
        const followUpTranscription = async () => {
          try {
            const followUp = await transcriptChannel.send({ content: 'Generating diagrams from the transcript…' })
            const out = await transcriptToDiagrams('recordings', sess.recordingId, undefined, '', async (m) => {
              try {
                await followUp.edit({ content: `🔄 ${m}` })
              } catch (e) {
                console.warn('onProgress followUp failed', e)
              }
            })
            const diagramData = await fs.readFile(out.kumuPath, 'utf-8')
            const pngData = await fs.readFile(out.pngPath)
            await followUp.edit({
              content: 'Here is the transcript and diagram generated from the recording:',
              files: [
                new AttachmentBuilder(Buffer.from(diagramData), { name: 'kumu.json' }),
                new AttachmentBuilder(pngData, { name: 'diagram.png' })
              ]
            })
          } catch (e: any) {
            try {
              await transcriptChannel.send({ content: `❌ Failed to stop/transcribe: ${e?.message ?? e}` })
            } catch {}
            if (transcriptChannel.id !== chat.channelId) {
              try {
                await chat.editReply({ content: `❌ Failed to stop/transcribe: ${e?.message ?? e}` })
              } catch {}
            }
          }
        }
        followUpTranscription()
        */
      } catch (e: any) {
        // The most common failure here is a 50027 (token expired after long
        // transcription). safeInteractionReply falls back to channel.send so
        // we don't both fail to deliver the message AND crash the process.
        await safeInteractionReply(chat, { content: `Failed to stop recording: ${e?.message ?? e}` })
      }
    }
  }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  // Re-read config per event so an operator edit takes effect immediately
  const alwaysRecordingChannelId = loadConfig().discord.alwaysRecordingChannelId
  if (!alwaysRecordingChannelId) return

  // Ignore events triggered by the bot itself
  if (oldState.member?.user.id === client.user?.id || newState.member?.user.id === client.user?.id) {
    return
  }

  const isRelevant =
    oldState.channelId === alwaysRecordingChannelId || newState.channelId === alwaysRecordingChannelId
  if (!isRelevant) return

  const channelId = alwaysRecordingChannelId
  const guild = newState.guild

  const channel = await client.channels.fetch(channelId).catch(() => null)
  if (!channel || !channel.isVoiceBased()) return

  const humanMembers = channel.members.filter((m) => !m.user.bot)

  // Re-check active status after async fetch, to avoid race conditions
  const currentActive = getActiveRecording(guild.id)

  // Helper to try and send to voice channel first (if supported), else fallback
  const getSendableChannel = async (id?: string) => {
    if (!id) return null
    try {
      const c = await client.channels.fetch(id)
      if (!c) return null
      // Check for send capability directly
      if ('send' in c && typeof (c as any).send === 'function') return c as TextChannel
      return null
    } catch {
      return null
    }
  }

  if (humanMembers.size > 0 && !currentActive) {
    try {
      // Prefer using the Voice Channel itself for transcripts (Voice-Text)
      // Otherwise fallback to env variable
      let targetTextChannelId = channelId // try voice channel first
      let dest = await getSendableChannel(targetTextChannelId)

      if (!dest) {
        targetTextChannelId = loadConfig().discord.recordingTranscriptChannelId || ''
        dest = await getSendableChannel(targetTextChannelId)
      }

      await startRecording(guild.id, channel, false, dest?.id)
      console.log(`[AutoRecord] Started recording in ${channel.name}`)
      if (dest) {
        await dest.send(`🎙️ Auto-recording started in <#${channelId}>.`).catch(() => {})
      }
    } catch (e) {
      console.error('[AutoRecord] Failed to start', e)
    }
  } else if (humanMembers.size === 0 && currentActive && currentActive.channelId === channelId) {
    try {
      const sess = await stopRecording(guild.id)
      if (!sess.vttPath) {
        console.log(`[AutoRecord] Stopped recording in ${channel.name} (no audio/cancelled)`)
        return
      }

      console.log(`[AutoRecord] Stopped recording in ${channel.name}`)

      const destId = sess.textChannelId || (loadConfig().discord.recordingTranscriptChannelId ?? undefined)
      const dest = await getSendableChannel(destId)

      if (dest) {
        const vtt = await fs.readFile(sess.vttPath)
        await dest
          .send({
            content: `✅ Auto-recording stopped. Transcript ready (ID: ${sess.recordingId}).`,
            files: [new AttachmentBuilder(Buffer.from(vtt), { name: 'audio.vtt' })]
          })
          .catch((e) => console.error('Failed to send transcript', e))
      }
    } catch (e) {
      console.error('[AutoRecord] Failed to stop', e)
    }
  }
})

client.on('interactionCreate', handleInteraction)

export async function handleMessage(message: Message) {
  try {
    await handleMessageInner(message)
  } catch (err) {
    // Any error reaching this point is an unhandled exception in the dispatch
    // path. Discord.js routes those to the Client's 'error' event which has no
    // default listener and crashes the process. Catch + log instead.
    console.error('[handleMessage] unhandled error:', err)
  }
}

/**
 * Resolve an incoming Discord message to a guild-bot thread:
 *   1. If we are in a Discord thread channel bound to a guild-bot thread → that thread.
 *   2. Else if the message is a direct reply (message.reference.messageId) to a bound
 *      bot reply → that thread.
 *   3. Else undefined.
 * No reply-chain walking (intentional per plan 005).
 */
async function resolveExistingThread(message: Message): Promise<string | undefined> {
  if (message.channel?.isThread?.()) {
    const byThread = await resolveDiscord({ kind: 'thread', key: message.channelId })
    if (byThread) return byThread
  }
  const refId = message.reference?.messageId
  if (refId) {
    const byReply = await resolveDiscord({ kind: 'reply', key: refId })
    if (byReply) return byReply
  }
  return undefined
}

// Prompt + memory injection lives in @guildbot/guild-config. Plan 007 R3.1:
// the dispatcher MUST call renderGuildSystemMessage() and append the result
// as the new thread's first message (kind: 'guild-prompt').

async function handleMessageInner(message: Message) {
  if (message.author.bot || message.system) return

  const botId = client.user?.id
  const isMention = botId ? message.mentions.has(botId) : false

  // resolve thread (Discord thread channel → reply binding).
  let threadId = await resolveExistingThread(message)

  // respond if a thread resolved OR the bot was mentioned; else bail.
  if (!threadId && !isMention) return

  try {
    await (message.channel as TextChannel).sendTyping()
  } catch (e) {
    console.warn('Failed to send typing indicator', e)
  }

  // Thread creation is only valid in text + announcement channels. Voice-channel
  // text chat, stage channels, forums, and DMs all reject startThread() with
  // DiscordjsError [MessageThreadParent].
  const channelType = message.channel.type
  const channelSupportsThreads =
    channelType === ChannelType.GuildText || channelType === ChannelType.GuildAnnouncement

  let reply: Message
  const shouldCreateDiscordThread =
    !threadId &&
    isMention &&
    !message.reference &&
    !message.channel.isThread?.() &&
    message.guild &&
    channelSupportsThreads

  let createdDiscordThreadChannelId: string | undefined

  if (shouldCreateDiscordThread) {
    const rawContent = message.content.replace(/<@!?[0-9]+>/g, '').trim()
    const threadName = rawContent.substring(0, 50) || 'Thread'
    try {
      const thread = await message.startThread({
        name: threadName,
        autoArchiveDuration: 60,
      })
      createdDiscordThreadChannelId = thread.id
      reply = await thread.send('Thinking...')
    } catch (e) {
      console.warn('Failed to start thread, falling back to inline reply', e)
      reply = await message.reply('Thinking...')
    }
  } else {
    reply = await message.reply('Thinking...')
  }

  const raw = message.content || ''
  const cleaned = botId ? raw.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim() : raw.trim()
  const question = cleaned || raw.trim()
  const guildId = message.guildId ?? 'unknown'

  // Create a guild-bot thread if we don't have one yet. Seed it with the
  // rendered guild prompt + memory as kind:'guild-prompt'. The snapshot path
  // is recorded on the thread's meta for later auditing.
  if (!threadId) {
    const rendered = await renderGuildSystemMessage()
    const created = await createThread({
      guildId: `discord:${guildId}`,
      title: question.slice(0, 80) || undefined,
      systemContext: {
        guildSystemPromptSnapshotPath: rendered.snapshotPath,
      },
    })
    threadId = created.id
    if (rendered.content.trim()) {
      await appendMessage(threadId, {
        role: 'system',
        kind: 'guild-prompt',
        content: rendered.content,
      })
    }
    if (createdDiscordThreadChannelId) {
      await bindDiscord({
        kind: 'thread',
        key: createdDiscordThreadChannelId,
        threadId,
      })
    }
  }

  // Session storage still owns attachment files (downstream tools read from here).
  // The thread's attachments/ dir is reserved for plan 005's fork-copy semantics
  // and will be populated by a later migration.
  const sessionDir = paths().sessions
  const session = await ensureSession(undefined, sessionDir, 'text')
  const sessionContext = {
    sessionId: session.id,
    sessionDir,
    sourceId: session.title || 'text',
  }

  try {
    const referencedMessage = await findReferencedMessage(message)
    const mapAttachment = (a: any) => ({ url: a.url, name: a.name, contentType: a.contentType })

    const referencedAttachments = referencedMessage
      ? await saveMessageAttachments(
          sessionContext.sessionDir,
          sessionContext.sessionId,
          referencedMessage.id,
          Array.from(referencedMessage.attachments.values()).map(mapAttachment),
        )
      : []

    const currentAttachments = await saveMessageAttachments(
      sessionContext.sessionDir,
      sessionContext.sessionId,
      message.id,
      Array.from(message.attachments.values()).map(mapAttachment),
    )

    const contextParts: string[] = []
    if (referencedMessage?.content) {
      contextParts.push(`Referenced Message:\n${referencedMessage.content}`)
    }
    const refAttString = await formatAttachmentsForPrompt(referencedAttachments)
    if (refAttString) contextParts.push(`Referenced Attachments:\n${refAttString}`)
    const curAttString = await formatAttachmentsForPrompt(currentAttachments)
    if (curAttString) contextParts.push(`Current Message Attachments:\n${curAttString}`)
    if (question) contextParts.push(`User Question:\n${question}`)
    const fullContext = contextParts.join('\n\n')

    // load prior history BEFORE appending the current user message, so
    // the agent loop sees prior turns and the loop itself adds the current
    // userMessage to its prompt (avoiding duplication).
    const history: ThreadMessage[] = await readMessages(threadId)

    // persist the user turn with sourceRef tying it to Discord.
    await appendMessage(threadId, {
      role: 'user',
      content: question,
      sourceRef: {
        platform: 'discord',
        messageId: message.id,
        channelId: message.channelId,
        userId: message.author.id,
      },
    })

    // wire onMessage to appendMessage. Errors propagate.
    const answer = await agentLoop({
      userMessage: fullContext,
      conversationHistory: history,
      context: {
        guildId: message.guildId ?? undefined,
        channelId: message.channelId,
        userId: message.author.id,
        sessionDir: sessionContext.sessionDir,
        threadId,
      } as any,
      model: loadConfig().llm.models.default,
      onProgress: (status) => {
        reply.edit(status).catch(() => {})
        if ('sendTyping' in reply.channel) {
          reply.channel.sendTyping().catch(() => {})
        }
      },
      onMessage: async (m) => {
        await appendMessage(threadId!, {
          role: m.role,
          content: m.content,
          toolName: m.toolName,
          toolCallId: m.toolCallId,
          toolCalls: m.toolCalls,
          sourceRef:
            m.role === 'assistant'
              ? { platform: 'discord', channelId: message.channelId }
              : undefined,
        })
      },
    })

    if (answer.length > 2000) {
      const att = new AttachmentBuilder(Buffer.from(answer, 'utf-8'), {
        name: `answer.txt`,
      })
      await reply.edit({ content: '', files: [att] })
    } else {
      await reply.edit({ content: answer })
    }

    // bind the assistant reply ID so replies to it resolve back to this thread.
    try {
      await bindDiscord({ kind: 'reply', key: reply.id, threadId })
    } catch (e) {
      console.warn('Failed to bind assistant reply to thread', e)
    }

    // Compaction runs after the agent loop has returned its final user-visible
    // assistant message — never mid-loop. Compaction is invisible to Discord:
    // no notice is posted to the channel. Errors here are logged and swallowed
    // so the user's reply still lands.
    try {
      const compaction = await runCompactionIfNeeded(threadId)
      const line = formatCompactionLog(threadId, compaction)
      if (line) console.log(line)
    } catch (e) {
      console.warn('[compaction] post-turn check failed', e)
    }
  } catch (e) {
    try {
      await reply.edit(`Error processing your question: ${e instanceof Error ? e.message : String(e)}`)
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (message.channel as any).send(
        `Error processing your question: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
}

client.on('messageCreate', handleMessage)

client.on('threadCreate', async (thread) => {
  // A human created a Discord thread on a bot reply we already bound. Mirror
  // that binding to the new thread channel so follow-ups in the thread resolve
  // to the same guild-bot thread.
  try {
    const starter = await thread.fetchStarterMessage()
    if (!starter) return
    const existing = await resolveDiscord({ kind: 'reply', key: (starter as any).id })
    if (existing) {
      await bindDiscord({ kind: 'thread', key: thread.id, threadId: existing })
    }
  } catch (e) {
    console.warn('threadCreate handler failed', e)
  }
})

client.on('messageCreate', async (message) => {
  if (message.author.bot) return
  try {
    await messageProcessor.processDiscordMessage(message)
  } catch (e) {
    console.error('Failed to process message', e)
  }
})

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (newMessage.author?.bot) return
  // newMessage might be partial. Fetch if needed.
  if (newMessage.partial) {
    try {
      await newMessage.fetch()
    } catch (e) {
      console.error('Failed to fetch updated message', e)
      return
    }
  }
  try {
    await messageProcessor.processDiscordMessage(newMessage as Message)
  } catch (e) {
    console.error('Failed to process message update', e)
  }
})

client.login(DISCORD_TOKEN).catch((e: unknown) => {
  console.error('Login failed', e)
  if (typeof process !== 'undefined' && typeof process.exit === 'function') process.exit(1)
})
