# guild-bot

An AI-powered knowledge tool for communities. It captures conversations and voice, builds a searchable memory from them, and answers questions — surfaced through a Discord interface and a local CLI.

The core capability is knowledge accumulation and retrieval: messages and transcripts are embedded into a vector store, an agent loop reasons over them using registered tools, and the result reaches users wherever they are.

## What it does

**Capture**
- Records Discord voice channels on demand or automatically when members join
- Transcribes audio to `.vtt` with Whisper (local, via ffmpeg)
- Syncs full channel message history into the vector store on startup

**Reason**
- An agent loop (Ollama + tool calling) handles open-ended questions by selecting and chaining tools until it has an answer
- Extracts causal relationships from transcripts and produces Kumu JSON and Mermaid diagrams
- Generates structured meeting digests: insights, action items, decisions, open questions

**Retrieve**
- Vector search over all ingested messages and transcripts
- Tag messages for manual curation; search by tag or content
- Ask free-text questions answered from the full guild history

## Interfaces

**Discord** — slash commands and mentions expose the full feature set to guild members.

| Command | What it does |
|---|---|
| `/record start` | Join a voice channel and begin recording |
| `/record stop` | Stop recording, post the `.vtt` transcript |
| `/record review` | Generate a meeting digest from a recording |
| `/diagram` | Convert an audio file or URL into a causal diagram |
| `/guild search` | Vector-search message history |
| `/guild tag` | Add or remove tags on a message |
| `/guild ask` | Ask a question answered from guild history |

`@guild-bot <question>` opens a thread and runs the agent loop directly.

Set `discord.alwaysRecordingChannelId` in the guild's `config.json` to auto-start and auto-stop recording as members join and leave.

**CLI** — `guildbot <command>` for offline and scripted use.

| Command | What it does |
|---|---|
| `transcribe <input> <output.txt>` | Transcribe a local audio file or YouTube URL |
| `diagram <transcript.txt> <graph.json>` | Extract a causal graph from a transcript |
| `kumu <graph.json> <output.json>` | Convert a graph to Kumu JSON |
| `mermaid <graph.json> <output.mmd>` | Render a graph as a Mermaid diagram |
| `init <guild-dir>` | Create and seed a new guild directory |
| `sync <guild-dir> [--force]` | Re-copy tools/skills from the codebase into a guild dir |

## Architecture

```
src/
  index.ts          — Discord client, slash-command routing, event listeners
  agent/loop.ts     — Ollama tool-calling loop (up to 5 iterations)
  tools/discover.ts — dynamically loads tools from the tools/ directory

tools/<name>/       — one directory per agent tool
  definition.json   — Ollama tool schema (name, description, parameters)
  handler.ts        — async function that executes the tool

modules/            — internal pnpm workspace packages
  guild-config      — per-guild config.json + secrets.json loader, path helpers (@guildbot/guild-config)
  database          — LanceDB vector store, message schema (@guildbot/database)
  embedding         — Ollama embedding calls (@guildbot/embedding)
  media             — audio download, Whisper transcription, diagram pipeline (@guildbot/media)
  recording         — @discordjs/voice capture + WebSocket transcription server (@guildbot/recording)
  message-processor — syncs Discord messages to the vector store (@guildbot/message-processor)
  rag               — vector search + LLM Q&A (@guildbot/rag)
  exporters         — Mermaid and RDF diagram exporters (@guildbot/exporters)
  interfaces        — ffmpeg/whisper wrappers, atomic file writes (@guildbot/interfaces)
  types             — shared TypeScript types (@guildbot/types)
```

**Agent loop** — when the bot receives a question it calls `agentLoop`, which sends the message to Ollama with the full tool list. The model calls tools (vector search, transcription, digest generation, etc.) and iterates until it has a final answer or hits the five-step limit.

**Tool registry** — tools are discovered at runtime by scanning `tools/*/definition.json`. Adding a new tool is just adding a new directory; no code changes required elsewhere.

**Data layer** — messages and transcripts are embedded and stored in LanceDB. Recordings land on disk under `recordings/<channelId-timestamp>/` as `audio.vtt` plus optional per-speaker `.wav` files.

## Registered tools

`search_messages` · `ask_knowledge_base` · `transcribe_audio` · `get_recording_transcript` · `generate_meeting_digest` · `extract_causal_relationships` · `export_kumu_json` · `export_mermaid_diagram` · `download_youtube` · `tag_message` · `remove_tags` · `get_message_by_id`

## Setup

Each Discord guild lives in its own self-contained directory containing a `config.json`, a `secrets.json` (mode `0600`), the LanceDB vector store, recordings, sessions, tools, skills, and per-guild prompt/memory. One process serves one guild dir.

```bash
pnpm install
pnpm tsx src/cli.ts init ~/.guildbot/myguild   # seed a new guild dir
$EDITOR ~/.guildbot/myguild/config.json        # set guild ID, LLM endpoint, etc.
$EDITOR ~/.guildbot/myguild/secrets.json       # add your Discord bot token
GUILDBOT_GUILD_DIR=~/.guildbot/myguild pnpm dev
```

Or pass `--guild-dir`:

```bash
pnpm tsx src/index.ts --guild-dir ~/.guildbot/myguild
```

The `config.example.json` and `secrets.example.json` at the repo root document every field. `config.json` is safe to share (e.g. attach to a bug report) — secrets always live in the sibling `secrets.json` and are never inline.

```bash
pnpm test              # vitest
pnpm lint              # tsc + eslint
```
