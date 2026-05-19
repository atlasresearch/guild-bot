import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted runs before vi.mock hoisting, so the variable is available in the factory (R5.2)
const { testRecordingsDir } = vi.hoisted(() => ({
  testRecordingsDir: join(require('node:os').tmpdir(), `guildbot-rec-test-${Date.now()}`)
}))

vi.mock('@guildbot/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/config')>()
  return { ...actual, RECORDINGS_DIR: testRecordingsDir }
})

import handler from './handler'

describe('get-recording-transcript handler', () => {
  const recordingId = 'test-recording-123'

  beforeEach(async () => {
    const recDir = join(testRecordingsDir, recordingId)
    await fsp.mkdir(recDir, { recursive: true })
    await fsp.writeFile(join(recDir, 'audio.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nHello world')
  })

  afterEach(async () => {
    await fsp.rm(testRecordingsDir, { recursive: true, force: true }).catch(() => {})
  })

  it('reads transcript by recording_id', async () => {
    const result = await handler({ recording_id: recordingId }, {})
    expect(result.success).toBe(true)
    expect((result.data as any).transcript).toContain('Hello world')
    expect((result.data as any).recording_id).toBe(recordingId)
  })

  it('fails when recording does not exist', async () => {
    await expect(handler({ recording_id: 'nonexistent' }, {})).rejects.toThrow()
  })
})
