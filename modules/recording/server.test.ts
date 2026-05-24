import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendVttWithUtcAnchor, tsToSeconds } from './server'

describe('appendVttWithUtcAnchor', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rec-server-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('rewrites relative chunk cues as absolute ISO 8601 UTC instants anchored at chunk start', async () => {
    const chunkPath = join(dir, 'chunk.vtt')
    writeFileSync(
      chunkPath,
      'WEBVTT\n\n00:00:01.500 --> 00:00:04.250\nHello there\n\n00:00:05.000 --> 00:00:07.000\nSecond cue\n',
      'utf8',
    )
    const anchor = Date.UTC(2026, 4, 24, 10, 0, 0) // 2026-05-24T10:00:00.000Z
    const destPath = join(dir, 'audio.vtt')

    await appendVttWithUtcAnchor(destPath, chunkPath, anchor)

    const out = readFileSync(destPath, 'utf8')
    expect(out.startsWith('WEBVTT\n\n')).toBe(true)
    expect(out).toContain('2026-05-24T10:00:01.500Z --> 2026-05-24T10:00:04.250Z')
    expect(out).toContain('Hello there')
    expect(out).toContain('2026-05-24T10:00:05.000Z --> 2026-05-24T10:00:07.000Z')
    expect(out).toContain('Second cue')
  })

  it('prefixes cue text with <v Name> when userName is provided', async () => {
    const chunkPath = join(dir, 'chunk.vtt')
    writeFileSync(
      chunkPath,
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nhi\n',
      'utf8',
    )
    const destPath = join(dir, 'audio.vtt')

    await appendVttWithUtcAnchor(destPath, chunkPath, Date.UTC(2026, 4, 24, 10, 0, 0), 'Ada Lovelace')

    const out = readFileSync(destPath, 'utf8')
    expect(out).toContain('<v Ada Lovelace> hi')
  })

  it('strips angle brackets from speaker names', async () => {
    const chunkPath = join(dir, 'chunk.vtt')
    writeFileSync(chunkPath, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nx\n', 'utf8')
    const destPath = join(dir, 'audio.vtt')

    await appendVttWithUtcAnchor(destPath, chunkPath, Date.UTC(2026, 4, 24, 10, 0, 0), '<script>tag</script>')

    const out = readFileSync(destPath, 'utf8')
    expect(out).toContain('<v scripttag/script> x')
    expect(out).not.toContain('<script>')
  })

  it('writes WEBVTT header once on first append and never again', async () => {
    const chunkPath = join(dir, 'chunk.vtt')
    writeFileSync(chunkPath, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfirst\n', 'utf8')
    const destPath = join(dir, 'audio.vtt')

    await appendVttWithUtcAnchor(destPath, chunkPath, Date.UTC(2026, 4, 24, 10, 0, 0))

    writeFileSync(chunkPath, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nsecond\n', 'utf8')
    await appendVttWithUtcAnchor(destPath, chunkPath, Date.UTC(2026, 4, 24, 10, 0, 10))

    const out = readFileSync(destPath, 'utf8')
    // Exactly one WEBVTT header at the top
    expect(out.match(/WEBVTT/g)?.length).toBe(1)
    expect(out).toContain('2026-05-24T10:00:00.000Z --> 2026-05-24T10:00:01.000Z')
    expect(out).toContain('first')
    expect(out).toContain('2026-05-24T10:00:10.000Z --> 2026-05-24T10:00:11.000Z')
    expect(out).toContain('second')
  })

  it('produces cues whose start instants are strictly chronological when appended in order', async () => {
    // Simulates the dispatcher behaviour: two chunks captured back-to-back from
    // the same speaker land in the combined VTT in wall-clock order.
    const destPath = join(dir, 'audio.vtt')
    const chunkPath = join(dir, 'chunk.vtt')
    const t0 = Date.UTC(2026, 4, 24, 10, 0, 0)

    writeFileSync(chunkPath, 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nA\n', 'utf8')
    await appendVttWithUtcAnchor(destPath, chunkPath, t0)

    writeFileSync(chunkPath, 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nB\n', 'utf8')
    await appendVttWithUtcAnchor(destPath, chunkPath, t0 + 5000)

    const out = readFileSync(destPath, 'utf8')
    const matches = [...out.matchAll(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) --> (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/g)]
    expect(matches).toHaveLength(2)
    expect(Date.parse(matches[0][1])).toBeLessThan(Date.parse(matches[1][1]))
    expect(Date.parse(matches[0][2])).toBeLessThanOrEqual(Date.parse(matches[1][1]))
  })
})

describe('tsToSeconds', () => {
  it('parses HH:MM:SS.mmm into a floating-point second count', () => {
    expect(tsToSeconds('00:00:00.000')).toBe(0)
    expect(tsToSeconds('00:00:01.500')).toBe(1.5)
    expect(tsToSeconds('01:02:03.456')).toBeCloseTo(3723.456, 5)
  })

  it('returns 0 for malformed input', () => {
    expect(tsToSeconds('not-a-timestamp')).toBe(0)
    expect(tsToSeconds('')).toBe(0)
  })
})
