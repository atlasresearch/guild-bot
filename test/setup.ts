// Vitest global setup. Creates a temp guild dir per pool and points the bot at
// it via GUILDBOT_GUILD_DIR, so any test that calls loadConfig()/paths() without
// an explicit override falls into an isolated fixture.
//
// Tests that need bespoke configs create their own temp dirs and either pass
// them explicitly or vi.mock the relevant module function.

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initGuildDir } from '@guildbot/guild-config'

const REPO_ROOT = resolve(__dirname, '..')

// One guild dir per vitest worker pool. Each pool gets a stable but unique path
// so concurrent tests do not stomp on each other.
const poolId = process.env.VITEST_POOL_ID || '0'
const guildDir = mkdtempSync(join(tmpdir(), `guildbot-test-pool-${poolId}-`))

if (!existsSync(guildDir + '/config.json')) {
  initGuildDir(guildDir, {
    codebaseRoot: REPO_ROOT,
    config: {
      guild: { id: `discord:test-pool-${poolId}`, name: `test-pool-${poolId}` },
      llm: {
        provider: 'ollama',
        dialect: 'auto',
        baseUrl: 'http://localhost:11434/v1',
        models: { default: 'qwen3.6', embed: 'nomic-embed-text' },
      },
    },
    secrets: { 'discord.token': `test-token-${poolId}` },
  })
}

process.env.GUILDBOT_GUILD_DIR = guildDir
