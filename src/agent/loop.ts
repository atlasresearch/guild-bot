import { Ollama } from 'ollama'
import { discoverSkillDescriptions } from '../skills/discover'
import { discoverToolDefinitions, loadToolHandler } from '../tools/discover'
import type { ToolContext, ToolResult } from '../tools/types'
import { DEFAULT_MODEL } from '@guildbot/config'
import { verbose } from '@guildbot/interfaces'

const MAX_ITERATIONS = 5

export type AgentLoopOptions = {
  userMessage: string
  conversationHistory: Array<{ role: string; content: string }>
  context: ToolContext
  model?: string
  toolsDir?: string
  skillsDir?: string
  /** Platform-agnostic progress callback. Called with a short status string at each agent step. */
  onProgress?: (status: string) => void
}

export function buildSystemPrompt(
  skillDescriptions: Array<{ name: string; description: string }>
): string {
  return `You are Guild Bot, a helpful assistant for a Discord community.

You have access to tools. You also know about these skills:
${skillDescriptions.map((s) => `- **${s.name}**: ${s.description}`).join('\n')}

Rules:
- ALWAYS use tools to answer questions — do not refuse or say you cannot access data. Try first.
- For broad questions like "what have we talked about", use search_messages with a general query.
- For questions that need a synthesized answer, use ask_knowledge_base.
- For audio/video content, use transcribe_audio first, then other tools on the result.
- Do not guess or hallucinate facts — if you need information, search for it.
- Never ask the user for permission to use a tool. Just use it.
- Keep responses concise and actionable.
- When you have enough information, respond directly without calling more tools.`
}

export async function agentLoop(options: AgentLoopOptions): Promise<string> {
  const { userMessage, conversationHistory, context, model, toolsDir, skillsDir, onProgress } = options
  const ollama = new Ollama()
  const emit = onProgress ?? (() => {})

  // R3.1: read from disk at the top of every invocation
  const tools = await discoverToolDefinitions(toolsDir)
  const skillDescriptions = await discoverSkillDescriptions(skillsDir)
  const systemPrompt = buildSystemPrompt(skillDescriptions)

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ]

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const usedModel = model ?? DEFAULT_MODEL
    verbose(`llm:request [iter=${i}]`, { model: usedModel, messageCount: messages.length, toolCount: tools.length })
    emit('Thinking...')

    const response = await ollama.chat({
      model: usedModel,
      messages,
      tools,
      think: false,
    } as Parameters<typeof ollama.chat>[0])

    if (response.message.tool_calls && response.message.tool_calls.length > 0) {
      verbose(`llm:response [iter=${i}] tool_calls`, response.message.tool_calls.map(tc => ({ name: tc.function.name, args: tc.function.arguments })))
      // Append assistant message with tool calls
      messages.push(response.message as unknown as { role: string; content: string })

      for (const toolCall of response.message.tool_calls) {
        const name = toolCall.function.name
        const args = toolCall.function.arguments as Record<string, unknown>
        const friendlyName = name.replace(/[_-]/g, ' ')
        emit(`Using ${friendlyName}...`)
        verbose(`tool:call ${name}`, args)
        let result: ToolResult
        try {
          const handler = await loadToolHandler(name, toolsDir)
          result = await handler(args, context)
        } catch (err) {
          // R3.9: append error as tool message and continue
          result = {
            success: false,
            data: { error: err instanceof Error ? err.message : String(err) },
          }
        }
        verbose(`tool:result ${name}`, { success: result.success, data: result.data })
        messages.push({ role: 'tool', content: JSON.stringify(result) })
      }
      continue
    }

    // R3.10: no tool_calls — return final answer
    verbose(`llm:response [iter=${i}] final`, response.message.content.slice(0, 200))
    return response.message.content
  }

  // R3.8: max iterations reached — return last model content
  return messages[messages.length - 1]?.content ?? ''
}
