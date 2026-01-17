import fsp from 'node:fs/promises'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { audioToTranscript } from './audioToDiagram'
import { CHAT_DIR } from './path'

describe('audioToDiagram', () => {
  const TEST_UNIVERSE = 'test-universe-' + Math.random().toString(36).slice(2)

  afterEach(async () => {
    const dir = path.join(CHAT_DIR, TEST_UNIVERSE)
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('should correctly reuse existing session based on transcript filename', async () => {
    const mockId = 'rec123'
    const existingDir = path.join(CHAT_DIR, TEST_UNIVERSE, mockId)
    await fsp.mkdir(existingDir, { recursive: true })

    // Create a dummy vtt file to simulate an existing recording
    await fsp.writeFile(path.join(existingDir, 'audio.vtt'), 'WEBVTT\n\n00:00 -> 00:01\nHello')

    // Simulate a URL that points to the transcript file
    // Discord attachment URLs typically end with filename
    const transcriptUrl = `https://cdn.discordapp.com/attachments/123/456/transcript-${mockId}.txt`

    // This should detect the existing file at rec123 and return the ID 'rec123'
    // ignoring the 'transcript-' prefix in the filename
    const resultId = await audioToTranscript(TEST_UNIVERSE, transcriptUrl)

    expect(resultId).toBe(mockId)
  })

  it('should handle standard filenames normally', async () => {
    const mockName = 'myfile'
    const dir = path.join(CHAT_DIR, TEST_UNIVERSE, mockName)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'audio.vtt'), 'WEBVTT')

    const resultId = await audioToTranscript(TEST_UNIVERSE, `https://example.com/${mockName}.mp3`)
    expect(resultId).toBe(mockName)
  })
})
