import ollama from 'ollama'
import { DEFAULT_MODEL } from '../path'

export type ToolDef = {
  /** internal name used when selecting a tool */
  name: string
  /** human friendly title */
  title: string
  /** one-sentence condition describing when the tool should be called */
  callWhen: string
  /** brief description */
  description?: string
}

export const TOOLS: ToolDef[] = [
  {
    name: 'transcribe',
    title: 'Transcribe Audio/Video',
    callWhen:
      'Call this when the user supplies or references an audio/video file (upload or URL) and asks for a transcript or asks questions that require transcribing audio/video content.',
    description: 'Upload audio or provide a URL to download video and produce a speaker-aligned transcript.'
  },
  {
    name: 'diagram',
    title: 'Diagram Generation',
    callWhen: 'Call this when the user asks to produce a diagram.',
    description: 'Turn audio, youtube videos or text content into a causal loop diagram.'
  },
  {
    name: 'meeting_summarise',
    title: 'Meeting Summarise',
    callWhen:
      'Call this when the user asks for a meeting summary, insights, action items, decisions or open questions derived from a meeting transcript or recording. Only use this if the source material is a transcript.',
    description: 'Generate meeting digest: insights, action items, decisions, open questions.'
  }
]

export const TOOL_NAMES = TOOLS.map((t) => t.name)

export async function chooseToolForMention(options: {
  question: string
  referenced?: { attachments?: string[]; content?: string }
  sessionId?: string
  sessionDir?: string
  model?: string
  onProgress?: (msg: string) => void
}): Promise<{ tool: string }> {
  const model = options.model || DEFAULT_MODEL

  const toolLines = TOOLS.map((t, i) => `${i + 1}. ${t.name} — ${t.callWhen}`).join('\n')

  const referencedText = options.referenced
    ? `${options.referenced.attachments ? `Attachments: ${options.referenced.attachments.join(', ')}` : ''}\n${options.referenced.content ? `Referenced message content: ${options.referenced.content}` : ''}`
    : ''

  const userInstructions = ['Context: ' + referencedText, 'Question: ' + options.question].join('\n')

  options.onProgress?.('[Tools] Choosing tool...')

  try {
    const response = await ollama.chat({
      model,
      format: 'json',
      messages: [
        {
          role: 'system',
          content: `You are a tool-selection assistant. Given the transcript and the user's message, choose exactly ONE tool from the available list. Only choose a tool if you are VERY CERTAIN it applies to the user request. If you are not very certain, return {"tool":"none"}. Output must be a single JSON object and nothing else, for example: {"tool":"diagram"}`
        },
        {
          role: 'user',
          content: `${userInstructions}\n\nAvailable tools and when to call them:\n\n${toolLines}`
        }
      ]
    })

    const raw = response.message?.content ?? ''
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.tool === 'string') return { tool: parsed.tool }
    } catch {
      // Try to extract JSON substring
      const m = raw.match(/\{[\s\S]*?\}/)
      if (m) {
        try {
          const parsed = JSON.parse(m[0])
          if (parsed && typeof parsed.tool === 'string') return { tool: parsed.tool }
        } catch {
          // ignore
        }
      }
    }
  } catch (e) {
    console.warn('[Tools] Tool selection failed:', e)
  }

  return { tool: 'none' }
}

export default {
  TOOLS,
  TOOL_NAMES,
  chooseToolForMention
}
