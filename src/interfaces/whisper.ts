import { exec as cpExec } from 'node:child_process'
import fs from 'node:fs'
import util from 'node:util'

const exec = util.promisify(cpExec)

function escapePath(p: string) {
  return `"${p.replace(/"/g, '\\"')}"`
}

export async function ensureWhisperAvailable() {
  try {
    await exec('whisper-cli --help')
  } catch (err) {
    throw new Error('whisper-cli not available on PATH')
  }
}

// models/ggml-base.en.bin

/**
 * Run whisper-cli to transcribe a WAV file to a TXT file.
 * - modelPath: path to ggml model
 * - wavPath: input wav file
 * - outTxtPath: expected output txt path (whisper-cli writes `<of>-transcript.txt` sometimes; to keep things simple we follow the original CLI flags and check the provided out file)
 * - outBase: base path (without extension) to pass to whisper-cli -of flag
 */
export async function transcribeWithWhisper(modelPath: string, inputPath: string, outPath: string, outBase: string) {
  const outputFormat = outPath.endsWith('.vtt') ? 'vtt' : 'txt'
  const oflag = outputFormat === 'vtt' ? '-ovtt' : '-otxt'
  const cmd = `whisper-cli -m ${escapePath(modelPath)} -f ${escapePath(inputPath)} ${oflag} -of ${escapePath(outBase)}`
  await exec(cmd, { maxBuffer: 20 * 1024 * 1024 })

  // Determine expected file path
  if (!fs.existsSync(outPath)) {
    throw new Error(`Whisper did not produce transcript at ${outPath}`)
  }
}
