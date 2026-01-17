import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import exportMermaid from './exporters/mermaidExporter'
import { exportGraphJSON, loadGraphJSON } from './exporters/rdfExporter'
import { ensureFfmpegAvailable } from './interfaces/ffmpeg'
import { debug, info } from './interfaces/logger'
import { ensureWhisperAvailable, transcribeWithWhisper } from './interfaces/whisper'
import { CHAT_DIR } from './path'
import { generateCausalRelationships } from './workflows/cld.workflow'

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
  // Use the input file directly (whisper supports mp3); no WAV conversion required
  const dir = path.dirname(transcriptPath)
  const outBase = path.join(dir, 'transcript')

  // Transcribe (WHISPER_MODEL env or default)
  const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), 'models/ggml-base.en.bin')
  await transcribeWithWhisper(WHISPER_MODEL, inputPath, transcriptPath, outBase)

  // Read raw transcript
  let transcript = await fsp.readFile(transcriptPath, 'utf8')

  // Single-call LLM scrub: remove advertising, promos, irrelevant tangents and noise
  // try {
  //   const scrubSystem = `The following is an audio recording transcription. Remove anything not directly about the recording's main topic. Include minor fixes for obvious split words or misspellings. Remove advertising, sponsor/donation/referral mentions, and calls-to-action (subscribe, follow, visit). Return only the cleaned transcript text (no notes, explanation, or JSON).`

  //   const resp = await callLLM(scrubSystem, transcript, 'llama3.1:8b')
  //   if (resp && resp.success && typeof resp.data === 'string' && resp.data.trim().length > 0) {
  //     transcript = resp.data.trim()
  //     // Persist cleaned transcript to the transcriptPath
  //     try {
  //       await fsp.writeFile(transcriptPath, transcript, 'utf8')
  //       debug('Wrote cleaned transcript to', transcriptPath)
  //     } catch (e) {
  //       debug('Failed to write cleaned transcript:', e)
  //     }
  //   } else {
  //     debug('LLM scrub returned empty or failed; using original transcript')
  //   }
  // } catch (e: any) {
  //   console.warn('LLM scrub failed, using raw transcript:', e?.message ?? e)
  // }

  return transcript
}

export async function downloadYoutubeSingleWithInfo(youtubeURL: string, sourceDir: string, audioFormat = 'mp3') {
  const ytdlp = 'yt-dlp'
  // ensure dir exists
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
    execFile(ytdlp, args, { cwd: sourceDir }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`yt-dlp (single) error: ${error.message}\n${stderr}`))
      resolve()
    })
  })
  const files = await fsp.readdir(sourceDir)
  const audioFiles = files.filter((f) => f.endsWith(`.${audioFormat}`))
  if (audioFiles.length === 0) throw new Error('No audio file produced by yt-dlp')
  // choose the first audio file
  const audioFile = audioFiles[0]
  return path.join(sourceDir, audioFile)
}

function normalizeTranscript(text: string) {
  return text.replace(/\r/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}

async function persistProgress(universe: string, id: string, msg: string) {
  try {
    const sourceDir = path.join(CHAT_DIR, universe, id)
    await fsp.mkdir(sourceDir, { recursive: true })
    const out = { status: msg, updated: Date.now() }
    await fsp.writeFile(path.join(sourceDir, 'progress.json'), JSON.stringify(out, null, 2), 'utf8')
  } catch (e) {
    debug('Failed to write progress.json', e)
  }
}

const notify = async (
  universe: string,
  id: string,
  msg: string,
  onProgress: (message: string) => void | Promise<void> = () => {}
) => {
  // call callback for live updates
  if (onProgress) {
    try {
      await Promise.resolve(onProgress(msg))
    } catch (e) {
      debug('onProgress callback failed', e)
    }
  }
  try {
    await persistProgress(universe, id, msg)
  } catch {}
}

export async function audioToTranscript(
  universe: string,
  audioURL: string,
  onProgress?: (message: string) => void | Promise<void>
) {
  const folder = path.join(CHAT_DIR, universe)

  await fsp.mkdir(folder, { recursive: true })

  const urlPath = audioURL.includes('youtube.com')
    ? new URL(audioURL).searchParams.get('v')!
    : audioURL.includes('youtu.be')
      ? new URL(audioURL).pathname.slice(1)
      : new URL(audioURL).pathname
  if (!urlPath) throw new Error('Invalid audio URL')

  const audioFormat = 'mp3'

  const originalName = path.basename(urlPath) || `audio-${Date.now()}`
  let baseName = path.basename(originalName, path.extname(originalName))

  // FIX: If handling a transcript file reference, strip the prefix to match the original ID
  if (baseName.startsWith('transcript-')) {
    baseName = baseName.replace(/^transcript-/, '')
  }

  // Always use a temp folder under the OS temp dir for generated artifacts.
  // If the source is a local `file://` URL, copy the file into the temp
  // directory so we don't read/write inside the repo or other user folders.
  let sourceDir = path.join(folder, baseName)
  await fsp.mkdir(sourceDir, { recursive: true })
  const transcriptPath = path.join(sourceDir, `audio.vtt`)

  try {
    if (audioURL.startsWith('file://')) {
      const fp = decodeURIComponent(new URL(audioURL).pathname)
      try {
        const stat = await fsp.stat(fp)
        if (stat.isFile()) {
          const audioFormat = 'mp3'
          const audioPath = path.join(sourceDir, `audio.${audioFormat}`)
          await fsp.copyFile(fp, audioPath)
        }
      } catch {
        // fallthrough: if we can't read/copy the local file, downstream
        // download/copy logic will try to fetch the URL normally and fail.
      }
    }
  } catch {
    // ignore malformed URL
  }

  // if transcript already exists, skip processing
  if (await fileExists(transcriptPath)) {
    debug('Transcript already exists at', transcriptPath, ', skipping processing')
    return baseName
  }

  await fsp.mkdir(sourceDir, { recursive: true })

  await notify(universe, baseName, 'Preparing dependencies (ffmpeg, whisper)…', onProgress)
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
      // Local path? If file exists locally, copy it.
      if (!src.startsWith('http://') && !src.startsWith('https://')) {
        // treat as local path
        const localPath = src.replace(/^file:\/\//, '')
        try {
          await fsp.copyFile(localPath, dest)
          return
        } catch (e) {
          // fallthrough to try download
          debug('Local copy of fathom file failed, will try download:', e)
        }
      }
      // Otherwise download via fetch
      await downloadToFile(src, dest)
    } catch (e) {
      throw new Error('Failed to obtain Fathom transcript: ' + (e as any)?.message || String(e))
    }
  }

  function parseFathomTranscript(content: string) {
    // Parse lines like: "0:00 - Speaker Name\n  text..." or "1:08:58 - Name"
    // Collect contiguous lines until next timestamp as a single chunk. Skip
    // explicit omitted markers (/* Lines ... omitted */) and short metadata.
    const lines = content.split(/\r?\n/)
    const chunks: string[] = []
    let curSpeaker: string | null = null
    let curText: string[] = []

    const tsRegex = /^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*(.*)$/
    for (let raw of lines) {
      const line = raw.trim()
      if (!line) continue
      // skip omitted markers
      if (/^\/\*\s*Lines\s+\d+/i.test(line)) continue
      // skip the "VIEW RECORDING" header lines or lines that are purely timing/labels
      if (/^VIEW RECORDING/i.test(line)) continue
      const m = line.match(tsRegex)
      if (m) {
        // flush previous
        if (curSpeaker || curText.length > 0) {
          const combined = (curSpeaker ? curSpeaker + ': ' : '') + curText.join(' ')
          const norm = normalizeTranscript(combined)
          if (norm) chunks.push(norm)
        }
        curSpeaker = m[2].trim()
        curText = []
        // If there's anything after speaker on same line, treat as first text
        // (e.g. "0:00 - Name\n  And all that, ..." vs "0:00 - Name  And all that")
        const remainder = ''
        if (remainder) curText.push(remainder)
        continue
      }
      // Otherwise it's content belonging to current block; if no speaker yet,
      // treat as anonymous text block
      if (!curSpeaker && chunks.length === 0) {
        // First block without timestamp: treat as intro; start anonymous
        curText.push(line)
      } else {
        curText.push(line)
      }
    }
    // flush last
    if (curSpeaker || curText.length > 0) {
      const combined = (curSpeaker ? curSpeaker + ': ' : '') + curText.join(' ')
      const norm = normalizeTranscript(combined)
      if (norm) chunks.push(norm)
    }

    return chunks
  }

  if (isFathom) {
    await notify(universe, baseName, 'Detected Fathom transcript; reading and parsing…', onProgress)
    const fathomPath = path.join(sourceDir, 'transcript.fathom.txt')
    await fsp.mkdir(sourceDir, { recursive: true })
    await downloadOrCopyFathom(audioURL, fathomPath)
    const content = await fsp.readFile(fathomPath, 'utf8')
    const parsed = parseFathomTranscript(content)
    for (const p of parsed) transcripts.push(p)
    console.log(`Parsed ${transcripts.length} transcript chunk(s) from Fathom file`)

    // Also generate a minimal VTT file so downstream tools/UI can consume a
    // standardized transcript format. Each chunk will be assigned a sequential
    // 10s window. This is best-effort since Fathom transcripts may not include
    // timestamps.
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
    // Ensure tools (ffmpeg, whisper) only when we need to process audio
    await notify(universe, baseName, 'Preparing dependencies (ffmpeg, whisper)…', onProgress)
    await ensureFfmpegAvailable()
    await ensureWhisperAvailable()

    if (!(await fileExists(audioPath))) {
      // Download strictly using chapter splitting for YouTube; for direct audio URLs, download as-is
      await notify(universe, baseName, `Downloading audio...`, onProgress)
      if (audioURL.includes('youtube.com') || audioURL.includes('youtu.be')) {
        // Download a single file + info.json, then transcribe once and split by chapters
        await downloadYoutubeSingleWithInfo(audioURL, sourceDir, audioFormat)
      } else {
        await downloadToFile(audioURL, audioPath)
      }
    }

    // Transcribe whole file to VTT (timestamps) so we can split per chapter
    const outBase = path.join(sourceDir, 'audio')
    const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), 'models/ggml-base.en.bin')
    if (!(await fileExists(transcriptPath))) {
      await transcribeWithWhisper(WHISPER_MODEL, audioPath, transcriptPath, outBase)
    }
  }
  // Read VTT content and try to extract either NOTE Chapter ranges (yt-dlp style)
  // or individual cue blocks. We want each timestamped section as its own transcript.
  const vttContent = (await fileExists(path.join(sourceDir, `audio.vtt`)))
    ? await fsp.readFile(path.join(sourceDir, `audio.vtt`), 'utf8')
    : ''

  // First, try to detect NOTE Chapter entries (some yt-dlp outputs include these)
  const chapterNoteRegex = /NOTE Chapter: (.+?)\s+(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/g
  let m: RegExpExecArray | null
  const chapters: Array<{ title: string; start: string; end: string }> = []
  while ((m = chapterNoteRegex.exec(vttContent)) !== null) {
    chapters.push({ title: m[1].trim(), start: m[2], end: m[3] })
  }

  // Regex to capture VTT cues: start --> end then the cue text (non-greedy)
  const cueRegex =
    /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\s*\n([\s\S]*?)(?=\n\s*\d{2}:\d{2}:\d{2}\.\d{3}\s*-->|$)/gm

  if (!isFathom) {
    if (chapters.length === 0) {
      // No chapters: split by each cue and use the cue text as a transcript chunk
      let cueMatch: RegExpExecArray | null
      while ((cueMatch = cueRegex.exec(vttContent)) !== null) {
        const cueText = cueMatch[3].replace(/\n+/g, ' ').trim()
        if (cueText.length > 0) transcripts.push(normalizeTranscript(cueText))
      }

      // Fallback: if no cues found (malformed VTT), use the whole transcript file
      if (transcripts.length === 0) {
        const fullTranscript = await fsp.readFile(transcriptPath, 'utf8')
        transcripts.push(normalizeTranscript(fullTranscript))
      }
    } else {
      // We have chapter ranges: for each chapter, collect cue texts that fall within the range
      for (const chapter of chapters) {
        let chapterText = ''
        let cueMatch: RegExpExecArray | null
        cueRegex.lastIndex = 0
        while ((cueMatch = cueRegex.exec(vttContent)) !== null) {
          const startTime = cueMatch[1]
          const endTime = cueMatch[2]
          // lexical compare works for HH:MM:SS.mmm format
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
    // Already parsed Fathom transcripts above
    console.log(`Using ${transcripts.length} parsed Fathom transcript chunk(s)`)
    console.log(transcripts)
  }

  // Build metadata: include a simple name derived from the file/base name
  const metadata: any = {
    name: originalName || baseName,
    source: audioURL,
    created: Date.now()
  }
  // For YouTube URLs include a thumbnail link (use video id stored in urlPath)
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

export async function transcriptToDiagrams(
  universe?: string | undefined,
  id?: string | undefined,
  transcript?: string | undefined,
  userPrompt?: string,
  onProgress?: (message: string) => void | Promise<void>,
  force = false
) {
  // Ensure we have a universe/id for artifact output; if caller only passed
  // a transcript string, create a temp universe/id under the OS temp dir.
  const outUniverse = universe || 'transcript'
  const outId = id || `t-${Date.now()}`
  const folder = path.join(CHAT_DIR, outUniverse)
  const sourceDir = path.join(folder, outId)

  const graphJSONPath = path.join(sourceDir, `graph.json`)

  let nodes: Array<{ label: string; type: string }> = []
  let relationships: Relationship[] = []
  let loadedFromGraph = false
  if ((await fileExists(graphJSONPath)) && !force) {
    try {
      await notify(outUniverse, outId, 'Loading existing graph data…', onProgress)
      const parsed = await loadGraphJSON(sourceDir)
      nodes = parsed.nodes
      relationships = parsed.relationships
      loadedFromGraph = true
      debug('Loaded nodes and relationships from graph JSON', graphJSONPath)
    } catch (e) {
      debug('Failed to load graph JSON, regenerating nodes/relationships', e)
    }
  }
  const progress = (msg: string) => notify(outUniverse, outId, msg, onProgress)
  if (!loadedFromGraph) {
    const transcripts: string[] = []
    // If a transcript string was provided, use it directly instead of reading
    // an `audio.vtt` from disk. Otherwise, read the VTT from `sourceDir`.
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
        // Split transcript into chunks by double-newline paragraphs. If that
        // yields one chunk only, keep the whole transcript as a single chunk.
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
      // Ensure output directory exists so artifacts can be written below
      await fsp.mkdir(sourceDir, { recursive: true })
    } else {
      // read all transcript chunks from VTT on disk
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
    await notify(outUniverse, outId, 'Extracting causal relationships (System Dynamics Bot)…', onProgress)
    const cld = await generateCausalRelationships(transcripts, userPrompt, progress)
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

  // Prepare minimal per-base markers and output paths
  const processingMarker = path.join(sourceDir, `processing`)
  const mermaidMDD = path.join(sourceDir, `mermaid.mdd`)
  const mermaidSVG = path.join(sourceDir, `mermaid.svg`)
  const mermaidPNG = path.join(sourceDir, `mermaid.png`)

  // Create processing marker (write timestamp)
  try {
    await fsp.writeFile(processingMarker, String(Date.now()), 'utf8')
  } catch {
    debug('Could not write processing marker')
  }

  // Export graph JSON if missing or empty
  try {
    const needGraph = !(await fileExists(graphJSONPath))
    if (needGraph || force) {
      info('Writing graph JSON for', outId)
      await notify(outUniverse, outId, 'Writing graph data…', onProgress)
      // read metadata if it exists
      let metadata = {
        name: outId,
        source: outId,
        created: Date.now()
      }
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

  // Export Mermaid if missing
  try {
    //force rewrite of mermaid artifacts
    rmSync(mermaidMDD, { force: true })
    rmSync(mermaidSVG, { force: true })
    rmSync(mermaidPNG, { force: true })
    const needMDD = !(await fileExists(mermaidMDD))
    const needSVG = !(await fileExists(mermaidSVG))
    const needPNG = !(await fileExists(mermaidPNG))
    if (needMDD || needSVG || needPNG || force) {
      info('Writing mermaid artifacts for', outId)
      await notify(outUniverse, outId, 'Rendering diagram (Mermaid)…', onProgress)
      await exportMermaid(sourceDir, 'mermaid', nodes, relationships)
    } else {
      debug('Mermaid artifacts already exist for', outId)
    }
  } catch (e: any) {
    console.warn('Failed to export mermaid for', id, e?.message ?? e)
  }

  await notify(outUniverse, outId, 'Finalizing…', onProgress)

  // Remove processing marker
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
