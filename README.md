# GuildBot (Discord Remote Chat + Diagrammer)

GuildBot is a TypeScript toolkit that turns Discord conversations and audio into structured insights and diagrams. It ships with a Discord bot, local transcription, graph exports, a lightweight web UI, and a CLI.

## What It Does

- Discord slash commands for audio-to-diagram (`/diagram`), and voice-channel recording/transcription (`/record start|stop`).
- Audio pipeline that downloads or receives audio, transcribes to VTT with Whisper, extracts causal relationships, and emits Mermaid/Kumu/graph JSON outputs.
- Optional web UI to import files or URLs (including YouTube), monitor progress, browse per-video graphs, and view a merged universe graph.
- CLI for one-off transcription, diagram generation, and format conversions.

## Using in a Discord Guild

- Start the bot with `DISCORD_TOKEN` set; if `GUILD_ID` is set at startup, slash commands register in that guild automatically.
- Run `/diagram` with either an audio attachment or a URL; the bot returns a graph plus a rendered diagram.
- Join a voice channel and run `/record start`, then `/record stop`; the bot records participants, transcribes to VTT, and posts diagrams and graph artifacts when ready.
- Outputs land under `.tmp/<universe>/<id>/` as `audio.mp3`, `audio.vtt`, `graph.json`, `kumu.json`, and `mermaid.(mdd|svg|png)`.

## Components (High Level)

- `src/index.ts`: Discord bot entrypoint and transcription WebSocket server.
- `src/audioToDiagram.ts` and `src/cld/`: audio download/transcription, causal extraction, and graph/diagram exporters.
- `ui/server` and `ui/web`: minimal UI to import, monitor, and browse graphs.
- CLI: `pnpx guildbot transcribe|diagram|kumu|mermaid` for standalone use.
