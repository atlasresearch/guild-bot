import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@guildbot/config', () => ({
  ROOT_DIR: os.tmpdir(),
}))

import handler from './handler'

describe('get-recording-transcript handler', () => {
  const tmpRecordingsDir = path.join(os.tmpdir(), '.tmp', 'recordings')
  const recordingId = 'test-recording-123'

  beforeEach(async () => {
    const recDir = path.join(tmpRecordingsDir, recordingId)
    await fsp.mkdir(recDir, { recursive: true })
    await fsp.writeFile(path.join(recDir, 'audio.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nHello world')
  })

  afterEach(async () => {
    await fsp.rm(tmpRecordingsDir, { recursive: true, force: true }).catch(() => {})
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
