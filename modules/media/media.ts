import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, paths } from '@guildbot/guild-config'
import { exportGraphJSON, exportMermaid, loadGraphJSON } from '@guildbot/exporters'
import { debug, ensureFfmpegAvailable, ensureWhisperAvailable, info, transcribeWithWhisper } from '@guildbot/interfaces'

// CLD generator type — callers can inject a real implementation
export type CldParserOutput = {
  nodes: Array<{ label: string; type: 'driver' | 'obstacle' | 'actor' | 'other' }>
  relationships: Array<{
    subject: string; object: string; predicate: 'positive' | 'negative'
    reasoning: string; relevant: string[]; createdAt: string
  }>
}
export type CldGenerator = (
  sentences: string[],
  userPrompt?: string,
  onProgress?: (msg: string) => void | Promise<void>,
) => Promise<CldParserOutput | { error: string }>

async function generateCausalRelationships(
  _sentences: string[], _userPrompt?: string, onProgress?: (msg: string) => void
): Promise<CldParserOutput | { error: string }> {
  onProgress?.('[CLD] No CLD generator provided — returning empty result')
  return { nodes: [], relationships: [] }
}

async function fileExists(p: string) {
  try {
    const stat = await fsp.stat(p)
    console.log(`File ${p} exists:`, stat.isFile() && stat.size > 0)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

function normalizeCSL(txt: string) {
  return txt
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractNodes(raw: string) {
  const set = new Set(
    normalizeCSL(raw)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  )
  return Array.from(set)
}

export function extractRelationships(raw: string) {
  return normalizeCSL(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export type Relationship = { subject: string; predicate: string; object: string }

export function toKumuJSON(nodes: Array<string | { label?: string; type?: string }>, relationships: Relationship[]) {
  // Normalize nodes to element objects preserving optional type metadata
  const labels: string[] = Array.from(
    new Set((nodes || []).map((n) => (typeof n === 'string' ? n : n.label || String(n))))
  )
  const elements = labels.map((label) => {
    const src = (nodes || []).find((n) => (typeof n === 'string' ? n === label : (n.label || '') === label))
    return typeof src === 'object' ? { label, type: (src as any).type } : { label }
  })

  const connections: Array<{ from: string; to: string; label?: string }> = []
  for (const rel of relationships) {
    const from = rel.subject
    const to = rel.object
    const label = rel.predicate
    if (from && to) connections.push({ from, to, label })
  }

  const elementLabels = new Set(elements.map((e) => e.label))
  for (const c of connections) {
    if (!elementLabels.has(c.from)) (elements.push({ label: c.from }), elementLabels.add(c.from))
    if (!elementLabels.has(c.to)) (elements.push({ label: c.to }), elementLabels.add(c.to))
  }

  return { elements, connections }
}

async function downloadToFile(url: string, dest: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await fsp.writeFile(dest, buf)
}

/**
 * Main exported function used by the discord command handler.
 * Accepts an audio file URL, returns the path to the generated Kumu JSON file.
 */
export async function transcribeAudioFile(inputPath: string, transcriptPath: string) {
  const dir = path.dirname(transcriptPath)
  const outBase = path.join(dir, 'transcript')

  const WHISPER_MODEL = loadConfig().recording.whisperModel || path.join(os.homedir(), 'models/ggml-base.en.bin')
  await transcribeWithWhisper(WHISPER_MODEL, inputPath, transcriptPath, outBase)

  const transcript = await fsp.readFile(transcriptPath, 'utf8')
  return transcript
}

export async function downloadYoutubeSingleWithInfo(youtubeURL: string, sourceDir: string, audioFormat = 'mp3') {
  const ytdlp = 'yt-dlp'
  await fsp.mkdir(sourceDir, { recursive: true })

  // enable progress persistence to this source directory and flush any pending
  // progress message we may have received earlier
  await new Promise<void>((resolve, reject) => {
    const args = [
      youtubeURL,
      '--sponsorblock-remove',
      'all',
      '-x',
      '--audio-quality',
      'lowest',
      '--audio-format',
      audioFormat,
      '-o',
      path.join(sourceDir, `audio.${audioFormat}`)
    ]
    execFile(ytdlp, args, { cwd: sourceDir }, (error, _stdout, stderr) => {
      if (error) return reject(new Error(`yt-dlp (single) error: ${error.message}\n${stderr}`))
      resolve()
    })
  })
  const files = await fsp.readdir(sourceDir)
  const audioFiles = files.filter((f) => f.endsWith(`.${audioFormat}`))
  if (audioFiles.length === 0) throw new Error('No audio file produced by yt-dlp')
  return path.join(sourceDir, audioFiles[0])
}

function normalizeTranscript(text: string) {
  return text.replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}

async function persistProgress(id: string, msg: string, mediaDir: string) {
  try {
    const sourceDir = path.join(mediaDir, id)
    await fsp.mkdir(sourceDir, { recursive: true })
    const out = { status: msg, updated: Date.now() }
    await fsp.writeFile(path.join(sourceDir, 'progress.json'), JSON.stringify(out, null, 2), 'utf8')
  } catch (e) {
    debug('Failed to write progress.json', e)
  }
}

const notify = async (
  id: string,
  msg: string,
  mediaDir: string,
  onProgress: (message: string) => void | Promise<void> = () => {}
) => {
  if (onProgress) {
    try {
      await Promise.resolve(onProgress(msg))
    } catch (e) {
      debug('onProgress callback failed', e)
    }
  }
  try {
    await persistProgress(id, msg, mediaDir)
  } catch {}
}

/**
 * Download/transcribe an audio URL and return the content ID (base name used for storage).
 * All artifacts go under mediaDir/{id}/ (default: MEDIA_DIR from config).
 *
 * @param audioURL  - HTTP(S) URL, YouTube URL, or file:// URL
 * @param onProgress - optional progress callback
 * @param mediaDir  - injectable directory for tests (R5.3); defaults to MEDIA_DIR
 */
export async function audioToTranscript(
  audioURL: string,
  onProgress?: (message: string) => void | Promise<void>,
  mediaDir: string = paths().media
) {
  await fsp.mkdir(mediaDir, { recursive: true })

  const urlPath = audioURL.includes('youtube.com')
    ? new URL(audioURL).searchParams.get('v')!
    : audioURL.includes('youtu.be')
      ? new URL(audioURL).pathname.slice(1)
      : new URL(audioURL).pathname
  if (!urlPath) throw new Error('Invalid audio URL')

  const audioFormat = 'mp3'

  const originalName = path.basename(urlPath) || `audio-${Date.now()}`
  let baseName = path.basename(originalName, path.extname(originalName))

  if (baseName.startsWith('transcript-')) {
    baseName = baseName.replace(/^transcript-/, '')
  }

  let sourceDir = path.join(mediaDir, baseName)
  await fsp.mkdir(sourceDir, { recursive: true })
  const transcriptPath = path.join(sourceDir, `audio.vtt`)

  try {
    if (audioURL.startsWith('file://')) {
      const fp = decodeURIComponent(new URL(audioURL).pathname)
      try {
        const stat = await fsp.stat(fp)
        if (stat.isFile()) {
          const audioPath = path.join(sourceDir, `audio.${audioFormat}`)
          await fsp.copyFile(fp, audioPath)
        }
      } catch {
        // fallthrough
      }
    }
  } catch {
    // ignore malformed URL
  }

  if (await fileExists(transcriptPath)) {
    debug('Transcript already exists at', transcriptPath, ', skipping processing')
    return baseName
  }

  await fsp.mkdir(sourceDir, { recursive: true })

  await notify(baseName, 'Preparing dependencies (ffmpeg, whisper)…', mediaDir, onProgress)
  await ensureFfmpegAvailable()
  await ensureWhisperAvailable()

  const audioPath = path.join(sourceDir, `audio.${audioFormat}`)
  // Support Fathom transcript files (may be local or remote). If the provided
  // audioURL points at a `.fathom.txt` transcript we will download/copy and
  // parse it into the same array-of-sentences (`transcripts`) used below and
  // skip audio download / Whisper transcription.
  const transcripts = [] as string[]

  const isFathom = String(audioURL || '')
    .toLowerCase()
    .includes('.fathom.txt')

  async function downloadOrCopyFathom(src: string, dest: string) {
    try {
      if (!src.startsWith('http://') && !src.startsWith('https://')) {
        const localPath = src.replace(/^file:\/\//, '')
        try {
          await fsp.copyFile(localPath, dest)
          return
        } catch (e) {
          debug('Local copy of fathom file failed, will try download:', e)
        }
      }
      await downloadToFile(src, dest)
    } catch (e) {
      throw new Error('Failed to obtain Fathom transcript: ' + (e as any)?.message || String(e))
    }
  }

  function parseFathomTranscript(content: string) {
    const lines = content.split(/\r?\n/)
    const chunks: string[] = []
    let curSpeaker: string | null = null
    let curText: string[] = []

    const tsRegex = /^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*(.*)$/
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      if (/^\/\*\s*Lines\s+\d+/i.test(line)) continue
      if (/^VIEW RECORDING/i.test(line)) continue
      const m = line.match(tsRegex)
      if (m) {
        if (curSpeaker || curText.length > 0) {
          const combined = (curSpeaker ? curSpeaker + ': ' : '') + curText.join(' ')
          const norm = normalizeTranscript(combined)
          if (norm) chunks.push(norm)
        }
        curSpeaker = m[2].trim()
        curText = []
        continue
      }
      if (!curSpeaker && chunks.length === 0) {
        curText.push(line)
      } else {
        curText.push(line)
      }
    }
    if (curSpeaker || curText.length > 0) {
      const combined = (curSpeaker ? curSpeaker + ': ' : '') + curText.join(' ')
      const norm = normalizeTranscript(combined)
      if (norm) chunks.push(norm)
    }

    return chunks
  }

  if (isFathom) {
    await notify(baseName, 'Detected Fathom transcript; reading and parsing…', mediaDir, onProgress)
    const fathomPath = path.join(sourceDir, 'transcript.fathom.txt')
    await fsp.mkdir(sourceDir, { recursive: true })
    await downloadOrCopyFathom(audioURL, fathomPath)
    const content = await fsp.readFile(fathomPath, 'utf8')
    const parsed = parseFathomTranscript(content)
    for (const p of parsed) transcripts.push(p)
    console.log(`Parsed ${transcripts.length} transcript chunk(s) from Fathom file`)

    try {
      const secondsPerChunk = 10
      function pad(n: number, width = 2) {
        return String(n).padStart(width, '0')
      }
      function secToVtt(t: number) {
        const hrs = Math.floor(t / 3600)
        const mins = Math.floor((t % 3600) / 60)
        const secs = Math.floor(t % 60)
        const ms = Math.floor((t - Math.floor(t)) * 1000)
        return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${String(ms).padStart(3, '0')}`
      }
      let t0 = 0
      let vtt = 'WEBVTT\n\n'
      for (let i = 0; i < transcripts.length; i++) {
        const start = t0
        const end = t0 + secondsPerChunk
        vtt += `${secToVtt(start)} --> ${secToVtt(end)}\n${transcripts[i]}\n\n`
        t0 = end
      }
      await fsp.writeFile(transcriptPath, vtt, 'utf8')
      debug('Wrote generated VTT for Fathom transcript to', transcriptPath)
    } catch (e) {
      debug('Failed to write VTT for Fathom transcript', e)
    }
  } else {
    await notify(baseName, 'Preparing dependencies (ffmpeg, whisper)…', mediaDir, onProgress)
    await ensureFfmpegAvailable()
    await ensureWhisperAvailable()

    if (!(await fileExists(audioPath))) {
      await notify(baseName, `Downloading audio...`, mediaDir, onProgress)
      if (audioURL.includes('youtube.com') || audioURL.includes('youtu.be')) {
        await downloadYoutubeSingleWithInfo(audioURL, sourceDir, audioFormat)
      } else {
        await downloadToFile(audioURL, audioPath)
      }
    }

    const outBase = path.join(sourceDir, 'audio')
    const WHISPER_MODEL = loadConfig().recording.whisperModel || path.join(os.homedir(), 'models/ggml-base.en.bin')
    if (!(await fileExists(transcriptPath))) {
      await transcribeWithWhisper(WHISPER_MODEL, audioPath, transcriptPath, outBase)
    }
  }

  const vttContent = (await fileExists(path.join(sourceDir, `audio.vtt`)))
    ? await fsp.readFile(path.join(sourceDir, `audio.vtt`), 'utf8')
    : ''

  const chapterNoteRegex = /NOTE Chapter: (.+?)\s+(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/g
  let m: RegExpExecArray | null
  const chapters: Array<{ title: string; start: string; end: string }> = []
  while ((m = chapterNoteRegex.exec(vttContent)) !== null) {
    chapters.push({ title: m[1].trim(), start: m[2], end: m[3] })
  }

  const cueRegex =
    /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\s*\n([\s\S]*?)(?=\n\s*\d{2}:\d{2}:\d{2}\.\d{3}\s*-->|$)/gm

  if (!isFathom) {
    if (chapters.length === 0) {
      let cueMatch: RegExpExecArray | null
      while ((cueMatch = cueRegex.exec(vttContent)) !== null) {
        const cueText = cueMatch[3].replace(/\n+/g, ' ').trim()
        if (cueText.length > 0) transcripts.push(normalizeTranscript(cueText))
      }

      if (transcripts.length === 0) {
        const fullTranscript = await fsp.readFile(transcriptPath, 'utf8')
        transcripts.push(normalizeTranscript(fullTranscript))
      }
    } else {
      for (const chapter of chapters) {
        let chapterText = ''
        let cueMatch: RegExpExecArray | null
        cueRegex.lastIndex = 0
        while ((cueMatch = cueRegex.exec(vttContent)) !== null) {
          const startTime = cueMatch[1]
          const endTime = cueMatch[2]
          if (startTime >= chapter.start && endTime <= chapter.end) {
            chapterText += cueMatch[3].replace(/\n+/g, ' ').trim() + ' '
          }
        }
        if (chapterText.trim().length > 0) transcripts.push(normalizeTranscript(chapterText))
      }
    }
    console.log(`Generated ${transcripts.length} transcript chunk(s) from ${chapters.length} chapter(s)`)
    console.log(transcripts)
  } else {
    console.log(`Using ${transcripts.length} parsed Fathom transcript chunk(s)`)
    console.log(transcripts)
  }

  const metadata: any = {
    name: originalName || baseName,
    source: audioURL,
    created: Date.now()
  }
  if (audioURL.includes('youtube.com') || audioURL.includes('youtu.be')) {
    try {
      const videoId = urlPath
      if (videoId) metadata.thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    } catch {
      // ignore
    }
  }
  try {
    await fsp.writeFile(path.join(sourceDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8')
  } catch (e) {
    debug('Failed to write metadata.json', e)
  }

  return baseName
}

/**
 * Generate diagrams from an existing transcript or content ID.
 * All artifacts go under mediaDir/{id}/ (default: MEDIA_DIR from config).
 *
 * @param id        - content ID (base name); if omitted, a temp ID is generated
 * @param transcript - raw transcript string (used instead of reading audio.vtt if provided)
 * @param userPrompt - optional prompt guidance
 * @param onProgress - optional progress callback
 * @param force      - force regeneration even if artifacts exist
 * @param cldGenerator - injectable CLD extraction function
 * @param mediaDir   - injectable directory for tests (R5.3); defaults to MEDIA_DIR
 */
export async function transcriptToDiagrams(
  id?: string | undefined,
  transcript?: string | undefined,
  userPrompt?: string,
  onProgress?: (message: string) => void | Promise<void>,
  force = false,
  cldGenerator?: CldGenerator,
  mediaDir: string = paths().media
) {
  const outId = id || `t-${Date.now()}`
  const sourceDir = path.join(mediaDir, outId)

  const graphJSONPath = path.join(sourceDir, `graph.json`)

  let nodes: Array<{ label: string; type: string }> = []
  let relationships: Relationship[] = []
  let loadedFromGraph = false
  if ((await fileExists(graphJSONPath)) && !force) {
    try {
      await notify(outId, 'Loading existing graph data…', mediaDir, onProgress)
      const parsed = await loadGraphJSON(sourceDir)
      nodes = parsed.nodes
      relationships = parsed.relationships
      loadedFromGraph = true
      debug('Loaded nodes and relationships from graph JSON', graphJSONPath)
    } catch (e) {
      debug('Failed to load graph JSON, regenerating nodes/relationships', e)
    }
  }
  const progress = (msg: string) => notify(outId, msg, mediaDir, onProgress)
  if (!loadedFromGraph) {
    const transcripts: string[] = []
    const cueRegex =
      /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\s*\n([\s\S]*?)(?=\n\s*\d{2}:\d{2}:\d{2}\.\d{3}\s*-->|$)/gm

    if (transcript && transcript.trim().length > 0) {
      const txt = transcript.trim()
      if (txt.startsWith('WEBVTT')) {
        let cueMatch: RegExpExecArray | null
        while ((cueMatch = cueRegex.exec(txt)) !== null) {
          const cueText = cueMatch[3].replace(/\n+/g, ' ').trim()
          if (cueText.length > 0) transcripts.push(cueText)
        }
      } else {
        const parts = txt
          .split(/\n{2,}/)
          .map((s) => normalizeTranscript(s))
          .filter(Boolean)
        if (parts.length > 1) {
          transcripts.push(...parts)
        } else {
          transcripts.push(normalizeTranscript(txt))
        }
      }
      console.log(`Using provided transcript (chunks=${transcripts.length}) for causal relationship extraction`)
      await fsp.mkdir(sourceDir, { recursive: true })
    } else {
      const vttPath = path.join(sourceDir, `audio.vtt`)
      if (!(await fileExists(vttPath))) {
        throw new Error('Transcript VTT file not found: ' + vttPath)
      }
      const vttContent = await fsp.readFile(vttPath, 'utf8')
      let cueMatch: RegExpExecArray | null
      while ((cueMatch = cueRegex.exec(vttContent)) !== null) {
        const cueText = cueMatch[3].replace(/\n+/g, ' ').trim()
        if (cueText.length > 0) transcripts.push(cueText)
      }
      console.log(
        `Using ${transcripts.length} transcript chunk(s) from ${sourceDir} for causal relationship extraction`
      )
    }
    await notify(outId, 'Extracting causal relationships (System Dynamics Bot)…', mediaDir, onProgress)
    const cldFn = cldGenerator ?? generateCausalRelationships
    const cld = await cldFn(transcripts, userPrompt, progress)
    if ('error' in cld) {
      console.error('CLD generation failed:', cld.error)
      throw new Error('Failed to extract any nodes or relationships')
    }
    nodes = cld.nodes
    relationships = cld.relationships
  }

  const kumu = toKumuJSON(nodes, relationships)

  const kumuPath = path.join(sourceDir, `kumu.json`)
  await fsp.writeFile(kumuPath, JSON.stringify(kumu, null, 2), 'utf8')

  const processingMarker = path.join(sourceDir, `processing`)
  const mermaidMDD = path.join(sourceDir, `mermaid.mdd`)
  const mermaidSVG = path.join(sourceDir, `mermaid.svg`)
  const mermaidPNG = path.join(sourceDir, `mermaid.png`)

  try {
    await fsp.writeFile(processingMarker, String(Date.now()), 'utf8')
  } catch {
    debug('Could not write processing marker')
  }

  try {
    const needGraph = !(await fileExists(graphJSONPath))
    if (needGraph || force) {
      info('Writing graph JSON for', outId)
      await notify(outId, 'Writing graph data…', mediaDir, onProgress)
      let metadata = { name: outId, source: outId, created: Date.now() }
      try {
        const metaPath = path.join(sourceDir, 'metadata.json')
        if (await fileExists(metaPath)) {
          const raw = await fsp.readFile(metaPath, 'utf8')
          metadata = JSON.parse(raw)
        }
      } catch (e) {
        debug('Failed to read metadata.json', e)
      }

      await exportGraphJSON(sourceDir, nodes, relationships, metadata)
    } else {
      debug('Graph JSON already exists for', id)
    }
  } catch (e: any) {
    console.warn('Failed to export graph JSON for', id, e?.message ?? e)
  }

  try {
    rmSync(mermaidMDD, { force: true })
    rmSync(mermaidSVG, { force: true })
    rmSync(mermaidPNG, { force: true })
    const needMDD = !(await fileExists(mermaidMDD))
    const needSVG = !(await fileExists(mermaidSVG))
    const needPNG = !(await fileExists(mermaidPNG))
    if (needMDD || needSVG || needPNG || force) {
      info('Writing mermaid artifacts for', outId)
      await notify(outId, 'Rendering diagram (Mermaid)…', mediaDir, onProgress)
      await exportMermaid(sourceDir, 'mermaid', nodes, relationships)
    } else {
      debug('Mermaid artifacts already exist for', outId)
    }
  } catch (e: any) {
    console.warn('Failed to export mermaid for', id, e?.message ?? e)
  }

  await notify(outId, 'Finalizing…', mediaDir, onProgress)

  try {
    await fsp.unlink(processingMarker).catch(() => {})
  } catch (e) {
    debug('Could not finalize markers for', outId, e)
  }

  return {
    dir: sourceDir,
    graphJSONPath,
    kumuPath,
    pngPath: mermaidPNG,
    svgPath: mermaidSVG,
    mermaid: { mdd: mermaidMDD, svg: mermaidSVG, png: mermaidPNG }
  }
}
