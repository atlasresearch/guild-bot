# Design Principles

These principles explain the *why* behind guild-bot's architecture. They are not aspirational — every major structural decision in the codebase traces back to one of them.

---

## Stateless process, durable state

The bot process holds no state in memory. Every fact that matters — messages, transcripts, embeddings, session context, tool definitions — lives either in the LanceDB vector store or as files on disk under `~/.guildbot-<env>/`.

This matters for a few reasons:

- **Restartability.** The process can crash, be redeployed, or be killed and restarted at any time without data loss or inconsistency. Startup syncs history; the system returns to the same state it left.
- **Debuggability.** There is no hidden in-memory state to inspect or reconstruct. If something went wrong, the files on disk show exactly what was recorded.
- **Testability.** Tests inject an environment directory and work against real files. There is nothing to mock that would not be mocked in production.

The agent loop reflects this too: tools and skill descriptions are read from disk at the top of every invocation, not cached at startup. The tool registry is always the live state of the filesystem.

---

## Single-purpose modules

The codebase is split into small packages, each with one job:

| Package | Job |
|---|---|
| `@guildbot/config` | Resolve paths and load `.env` |
| `@guildbot/database` | Read and write the vector store |
| `@guildbot/embedding` | Turn text into vectors |
| `@guildbot/media` | Download audio, run Whisper, produce diagrams |
| `@guildbot/recording` | Capture Discord voice and transcribe it |
| `@guildbot/message-processor` | Ingest Discord messages into the store |
| `@guildbot/rag` | Search and answer questions from the store |
| `@guildbot/exporters` | Render graphs as Mermaid or RDF |
| `@guildbot/interfaces` | Wrap ffmpeg, Whisper, and atomic file writes |

Each package can be developed, tested, and reasoned about independently. No package imports from another at the same level unless there is a deliberate dependency. The Discord bot and CLI are thin wrappers that compose these packages — they contain no core logic themselves.

---

## Tools as the unit of agent capability

Agent capabilities are not hardcoded into the agent loop. Each tool is a self-contained directory:

```
tools/search-messages/
  definition.json   ← the schema the LLM sees
  handler.ts        ← the code that executes
```

The agent loop discovers all tools by scanning the directory at runtime. Adding a new capability means adding a new directory. No routing table, registry, or switch statement needs to change.

This also means the live tool set is not fixed by the codebase. Tools are seeded into `~/.guildbot-<env>/tools/` on first run, and can be modified there without touching the repo. `guildbot sync` re-copies from the codebase when you want to reset or update.

The same pattern applies to skills: a `SKILL.md` file with YAML frontmatter is enough to surface a skill description to the LLM.

---

## The LLM decides, not the code

Before the agent loop existed, each slash command was a hardcoded pipeline: receive input → call specific function → return result. That works until the inputs are ambiguous, the question spans multiple capabilities, or you want to add a capability without modifying command handlers.

The agent loop inverts this. The LLM receives the user's message and the full list of available tools, and decides what to call and in what order. The code only defines *what each tool does*, not *when to use it*. New tools become available to every entry point — Discord mentions, slash commands, CLI — the moment they exist on disk.

---

## Local-first

All AI inference runs locally via Ollama. Transcription runs locally via Whisper. No conversation content, voice data, or embeddings leave the machine.

This is not just a privacy stance — it also means the system works without internet access, has no per-token cost at inference time, and can be run against any model the operator chooses by setting `DEFAULT_MODEL`.

---

## Environment isolation over configuration flags

Dev and prod are not branches of the same running process controlled by a flag. They are separate environment directories (`~/.guildbot-dev`, `~/.guildbot-prod`), each with their own database, recordings, sessions, and `.env`. The `GUILDBOT_ENV` variable selects which directory to use.

This means you can run both environments on the same machine without them interfering, migrate one independently of the other, and wipe dev without touching prod. Tests inject their own throwaway directory and are fully isolated by the same mechanism.
