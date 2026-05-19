import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { audioToTranscript } from './media'

// R5.1, R5.2: tests use a temporary media directory, never ~/.guildbot-* (R5.3)
describe('audioToTranscript', () => {
  let testMediaDir: string

  beforeEach(async () => {
    testMediaDir = await mkdtemp(join(tmpdir(), 'guildbot-media-test-'))
  })

  afterEach(async () => {
    await rm(testMediaDir, { recursive: true, force: true })
  })

  it('should correctly reuse existing session based on transcript filename', async () => {
    const mockId = 'rec123'
    const existingDir = join(testMediaDir, mockId)
    await mkdir(existingDir, { recursive: true })

    // Simulate an existing transcript
    await writeFile(join(existingDir, 'audio.vtt'), 'WEBVTT\n\n00:00 -> 00:01\nHello')

    // Discord attachment URLs typically end with filename; transcript- prefix is stripped
    const transcriptUrl = `https://cdn.discordapp.com/attachments/123/456/transcript-${mockId}.txt`

    const resultId = await audioToTranscript(transcriptUrl, undefined, testMediaDir)
    expect(resultId).toBe(mockId)
  })

  it('should handle standard filenames normally', async () => {
    const mockName = 'myfile'
    const dir = join(testMediaDir, mockName)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'audio.vtt'), 'WEBVTT')

    const resultId = await audioToTranscript(`https://example.com/${mockName}.mp3`, undefined, testMediaDir)
    expect(resultId).toBe(mockName)
  })
})
