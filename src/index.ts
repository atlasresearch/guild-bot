import dotenv from 'dotenv'

// use .env.dev in dev mode, .env.prod in production
if (process.env.NODE_ENV === 'development') {
  dotenv.config({ path: '.env.dev' })
  console.log('Loaded development .env.dev file')
} else if (process.env.NODE_ENV === 'test') {
  dotenv.config({ path: '.env.test' })
  console.log('Loaded test .env.test file')
} else {
  dotenv.config({ path: '.env.prod' })
  console.log('Loaded production .env.prod file')
}

import {
  ApplicationCommandDataResolvable,
  ApplicationCommandOptionType,
  AttachmentBuilder,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
  Message,
  Partials,
  TextBasedChannel,
  TextChannel
} from 'discord.js'

import fs from 'fs/promises'
import path from 'path'
import {
  answerQuestion,
  ASKQUESTION_CONSTANTS,
  cloneAskQuestionContext,
  ensureSession,
  formatAttachmentsForPrompt,
  getAskQuestionContext,
  rememberAskQuestionContext,
  saveMessageAttachments,
  UNIVERSE
} from './askQuestion'
import { audioToTranscript, transcriptToDiagrams } from './audioToDiagram'
import * as db from './database/db'
import { CHAT_DIR } from './path'
import { getActiveRecording, startRecording, stopRecording } from './recording/discord'
import { startTranscriptionServer } from './recording/server'
import * as messageProcessor from './services/messageProcessor'
import * as ragService from './services/rag'
import { generateMeetingDigest } from './workflows/meetingDigest.workflow'
import { chooseToolForMention } from './workflows/tools'

const DISCORD_TOKEN: string | undefined = process.env.DISCORD_TOKEN
const LLM_URL: string | undefined = process.env.LLM_URL
const RECORDINGS_ROOT = path.resolve(process.cwd(), '.tmp', 'recordings')

// Knowledge Base Services - Init
db.initDB(process.env.NODE_ENV).catch(console.error)

const findRecordingById = async (recordingId?: string) => {
  if (!recordingId) return undefined
  const vttPath = path.join(RECORDINGS_ROOT, recordingId, 'audio.vtt')
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
          const vttPath = path.join(RECORDINGS_ROOT, d.name, 'audio.vtt')
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

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment')
  process.exit(1)
}
if (!LLM_URL) {
  console.error('Missing LLM_URL in environment')
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

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`)

  try {
    await startTranscriptionServer()
  } catch (e) {
    console.warn('Transcription server failed to start', e)
  }

  try {
    const guildId = process.env.GUILD_ID
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
              name: 'ask',
              description: 'Ask a question based on history',
              type: ApplicationCommandOptionType.Subcommand,
              options: [
                { name: 'question', description: 'Question', type: ApplicationCommandOptionType.String, required: true }
              ]
            }
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
            const vttPath = path.join(RECORDINGS_ROOT, recordingId, 'audio.vtt')

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

export async function handleInteraction(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return
  const chat = interaction as ChatInputCommandInteraction

  if (chat.commandName === 'guild') {
    const sub = chat.options.getSubcommand()
    await chat.deferReply()

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
          const lines = content.split('\n')
          const snippet = lines.filter(Boolean).slice(0, 2).join('\n')
          const snip = snippet.length > 200
          const snippetShortened = snip ? snippet.substring(0, 197) : snippet
          const more = snip ? '...' : ''
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

      const id = await audioToTranscript(UNIVERSE, url, onProgress)
      const { kumuPath, pngPath } = await transcriptToDiagrams(
        UNIVERSE,
        id,
        undefined,
        userPrompt,
        onProgress,
        regenerate
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
        const digest = await generateMeetingDigest(
          transcriptLines,
          prompt,
          async (m) => {
            try {
              await chat.editReply({ content: `🔄 ${m}` })
            } catch {}
          },
          undefined,
          resolved.recordingId,
          path.join(RECORDINGS_ROOT, 'sessions')
        )

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

        const transcriptChannel =
          (await fetchTextChannel(process.env.RECORDING_TRANSCRIPT_CHANNEL_ID)) ||
          (await fetchTextChannel(sess.textChannelId ?? active?.textChannelId)) ||
          chat.channel

        if (!ensureSendableChannel(transcriptChannel)) {
          await chat.editReply({ content: 'Failed to find a text channel to post the transcript.' })
          return
        }

        const vtt = await fs.readFile(sess.vttPath)
        const transcriptPayload = {
          content: `✅ Transcript ready (ID: ${sess.recordingId}).`,
          files: [new AttachmentBuilder(Buffer.from(vtt), { name: 'audio.vtt' })]
        }

        if (transcriptChannel.id === chat.channelId) {
          await chat.editReply(transcriptPayload)
        } else {
          await chat.editReply({
            content: `✅ Transcript ready (ID: ${sess.recordingId}). Posted to <#${transcriptChannel.id}>.`
          })
          try {
            await transcriptChannel.send(transcriptPayload)
          } catch (e: any) {
            await chat.editReply({
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
        await chat.editReply({ content: `Failed to stop recording: ${e?.message ?? e}` })
      }
    }
  }
}

client.on('interactionCreate', handleInteraction)

export async function handleMessage(message: Message) {
  if (message.author.bot || message.system) return

  const botId = client.user?.id
  const isMention = botId ? message.mentions.has(botId) : false
  const contextKey = message.channel?.isThread?.() ? message.channelId : message.reference?.messageId
  const existingContext = await getAskQuestionContext(contextKey)
  // const isThread = !!message.channel?.isThread?.()

  if (!isMention && !existingContext) return

  try {
    await (message.channel as TextChannel).sendTyping()
  } catch (e) {
    console.warn('Failed to send typing indicator', e)
  }

  let reply: Message
  const shouldCreateThread = isMention && !message.reference && !message.channel.isThread?.() && message.guild

  if (shouldCreateThread) {
    const rawContent = message.content.replace(/<@!?[0-9]+>/g, '').trim()
    const threadName = rawContent.substring(0, 50) || 'Thread'
    const thread = await message.startThread({
      name: threadName,
      autoArchiveDuration: 60
    })
    reply = await thread.send('Optimizing tool selection...')
  } else {
    reply = await message.reply('Optimizing tool selection...')
  }

  const raw = message.content || ''
  const cleaned = botId ? raw.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim() : raw.trim()
  const question = cleaned || raw.trim()

  let sessionContext = existingContext

  try {
    if (!sessionContext) {
      const session = await ensureSession(undefined, ASKQUESTION_CONSTANTS.SESSION_DIR, 'text')
      sessionContext = {
        sessionId: session.id,
        sessionDir: ASKQUESTION_CONSTANTS.SESSION_DIR,
        sourceId: session.title || 'text'
      }
    }

    const onProgress = async (m: string) => {
      try {
        await reply.edit(m)
      } catch {}
    }

    const referencedMessage = await findReferencedMessage(message)

    const mapAttachment = (a: any) => ({ url: a.url, name: a.name, contentType: a.contentType })

    const referencedAttachments = referencedMessage
      ? await saveMessageAttachments(
          sessionContext.sessionDir,
          sessionContext.sessionId,
          referencedMessage.id,
          Array.from(referencedMessage.attachments.values()).map(mapAttachment)
        )
      : []

    const currentAttachments = await saveMessageAttachments(
      sessionContext.sessionDir,
      sessionContext.sessionId,
      message.id,
      Array.from(message.attachments.values()).map(mapAttachment)
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

    // Tool selection
    // We pass the full context as 'referenced.content' to give the tool chooser full visibility
    const chooser = await chooseToolForMention({
      question: question || '(No text, checking attachments)',
      referenced: {
        content: fullContext,
        attachments: []
      },
      model: ASKQUESTION_CONSTANTS.MODEL
    })

    const tool = chooser?.tool
    if (tool && tool !== 'none') {
      await reply.edit(`Using ${tool} tool...`)

      // Existing tool logic (modified slightly to be robust)
      if (tool === 'diagram') {
        const attachment = message.attachments.first()
        // Use local path if we have it?
        // Logic for audioToDiagram (which uses a URL/path)
        const targetUrl = attachment?.url ?? message.content.match(/https?:\/\/\S+/)?.[0]
        // Fallback to referenced?
        const refUrl =
          referencedMessage?.attachments.first()?.url ?? referencedMessage?.content.match(/https?:\/\/\S+/)?.[0]

        const validUrl = targetUrl || refUrl

        if (!validUrl) {
          await reply.edit('I could not find an audio attachment or URL to generate a diagram from.')
          return
        }

        await reply.edit('Generating diagram from the provided audio…')
        // We use the URL because audioToDiagram likely handles downloading/caching separately or supports URLs
        console.log('diagram tool using URL:', validUrl, contextParts)
        const id = await audioToTranscript(UNIVERSE, validUrl, onProgress)
        const out = await transcriptToDiagrams(UNIVERSE, id, fullContext, question, onProgress, false)
        const diagramData = await fs.readFile(out.kumuPath, 'utf-8')
        const pngData = await fs.readFile(out.pngPath)
        await reply.edit({
          content: 'Here is your diagram:',
          files: [
            new AttachmentBuilder(Buffer.from(diagramData), { name: 'kumu.json' }),
            new AttachmentBuilder(pngData, { name: 'diagram.png' })
          ]
        })
        return
      }

      if (tool === 'transcribe') {
        const attachment = message.attachments.first()
        const targetUrl =
          attachment?.url ??
          message.content.match(/https?:\/\/\S+/)?.[0] ??
          referencedMessage?.attachments.first()?.url ??
          referencedMessage?.content.match(/https?:\/\/\S+/)?.[0]

        if (!targetUrl) {
          await reply.edit('I could not find an audio attachment or URL to transcribe.')
          return
        }
        await reply.edit('Transcribing audio…')
        try {
          const id = await audioToTranscript(UNIVERSE, targetUrl, onProgress)
          const vttPath = path.join(CHAT_DIR, UNIVERSE, id, 'audio.vtt')
          const vtt = await fs.readFile(vttPath, 'utf-8')
          if (vtt.length < 1900) {
            await reply.edit({ content: `Transcript:\n\n${vtt}` })
          } else {
            const att = new AttachmentBuilder(Buffer.from(vtt, 'utf-8'), { name: `transcript-${id}.txt` })
            await reply.edit({ content: 'Transcript generated:', files: [att] })
          }
        } catch (e: any) {
          await reply.edit({ content: `Failed to transcribe: ${e?.message ?? e}` })
        }
        return
      }

      if (tool === 'meeting_summarise') {
        // Reuse fullContext as transcript lines?
        // fullContext contains "Referenced Message: ...", "Attachments: ..."
        // It might not be a clean transcript.
        // But if the user replied to a transcript, it will be in referencedMessage.content

        const transcriptLines = fullContext
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)

        if (!transcriptLines.length) {
          await reply.edit('No transcript text available to summarise.')
          return
        }
        await reply.edit('Generating meeting summary…')
        try {
          const digest = await generateMeetingDigest(transcriptLines, undefined, async (m) => {
            try {
              await reply.edit(`🔄 ${m}`)
            } catch {}
          })
          const formatted = formatMeetingDigest(digest)
          if (formatted.length < 2000) {
            await reply.edit({ content: formatted })
          } else {
            const att = new AttachmentBuilder(Buffer.from(formatted, 'utf-8'), {
              name: `meeting-digest.txt`
            })
            await reply.edit({ content: 'Here is the meeting digest:', files: [att] })
          }
        } catch (e: any) {
          await reply.edit({ content: `Failed to generate meeting digest: ${e?.message ?? e}` })
        }
        return
      }
    }

    await reply.edit('Thinking...')

    const answer = await answerQuestion({
      context: fullContext,
      question: question || '(No text question, analysis req)',
      sessionId: sessionContext.sessionId,
      sessionDir: sessionContext.sessionDir,
      model: ASKQUESTION_CONSTANTS.MODEL,
      sourceId: sessionContext.sourceId
    })

    if (answer.answer.length > 2000) {
      const att = new AttachmentBuilder(Buffer.from(answer.answer, 'utf-8'), {
        name: `answer-${answer.sessionId}.txt`
      })
      await reply.edit({ content: '', files: [att] })
    } else {
      await reply.edit({ content: answer.answer })
    }
  } catch (e) {
    try {
      await reply.edit(`Error processing your question: ${e instanceof Error ? e.message : String(e)}`)
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (message.channel as any).send(
        `Error processing your question: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  } finally {
    const targetKey = reply.channel?.isThread?.() ? reply.channelId : undefined
    if (targetKey && sessionContext) {
      await rememberAskQuestionContext(targetKey, sessionContext)
    }
  }
}

client.on('messageCreate', handleMessage)

client.on('threadCreate', async (thread) => {
  try {
    const starter = await thread.fetchStarterMessage()
    if (!starter) return
    await cloneAskQuestionContext((starter as any).id, thread.id)
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
