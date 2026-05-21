import { chat, type LlmMessage, type LlmTool } from '@guildbot/llm'
import { discoverSkillDescriptions } from '../skills/discover'
import { discoverToolDefinitions, loadToolHandler } from '../tools/discover'
import type { ToolContext, ToolResult } from '../tools/types'
import { verbose } from '@guildbot/interfaces'

const MAX_ITERATIONS = 5

// Structural shape for messages the loop emits to onMessage(). Matches the
// fields a thread store needs without importing @guildbot/threads (R3.3).
export type AgentMessageInput = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  toolCallId?: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
}

export type OnAgentMessage = (msg: AgentMessageInput) => Promise<void>

export type AgentLoopOptions = {
  userMessage: string
  /**
   * Prior conversation history. ThreadMessage[] is structurally compatible —
   * its extra fields (id/seq/ts/kind/sourceRef) are ignored by the loop. R3.1.
   */
  conversationHistory: LlmMessage[]
  context: ToolContext
  model?: string
  toolsDir?: string
  skillsDir?: string
  /** Platform-agnostic progress callback. Called with a short status string at each agent step. */
  onProgress?: (status: string) => void
  /**
   * Called for every message the loop produces during execution (assistant
   * turns, including ones containing tool_calls, and tool result messages).
   * The userMessage is NOT replayed through onMessage — the dispatcher
   * persists the user turn before invoking the loop. R3.2.
   *
   * If onMessage throws, the loop aborts and propagates the error. R3.4.
   */
  onMessage?: OnAgentMessage
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
  const {
    userMessage,
    conversationHistory,
    context,
    model,
    toolsDir,
    skillsDir,
    onProgress,
    onMessage,
  } = options
  const emit = onProgress ?? (() => {})
  const notify: OnAgentMessage = onMessage ?? (async () => {})

  // R3.1: read from disk at the top of every invocation
  const tools = (await discoverToolDefinitions(toolsDir)) as LlmTool[]
  const skillDescriptions = await discoverSkillDescriptions(skillsDir)
  const systemPrompt = buildSystemPrompt(skillDescriptions)

  // Strip ThreadMessage-only fields when forwarding to the LLM. The history
  // can be passed in directly as ThreadMessage[] thanks to structural typing,
  // but chat() should only see LlmMessage fields.
  const historyForLlm: LlmMessage[] = conversationHistory.map((m) => ({
    role: m.role,
    content: m.content,
    toolName: m.toolName,
    toolCallId: m.toolCallId,
    toolCalls: m.toolCalls,
  }))

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyForLlm,
    { role: 'user', content: userMessage },
  ]

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    verbose(`llm:request [iter=${i}]`, { messageCount: messages.length, toolCount: tools.length })
    emit('Thinking...')

    const response = await chat({
      model,
      messages,
      tools,
      thinking: false,
    })

    if (response.toolCalls.length > 0) {
      verbose(
        `llm:response [iter=${i}] tool_calls`,
        response.toolCalls.map((tc) => ({ name: tc.name, args: tc.arguments })),
      )
      const assistantMessage: LlmMessage = {
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      }
      messages.push(assistantMessage)
      // R3.2: notify onMessage for the assistant turn (which carries the tool calls).
      // R3.4: errors propagate, aborting the loop.
      await notify({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
      })

      for (const toolCall of response.toolCalls) {
        const name = toolCall.name
        const args = toolCall.arguments
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
        const toolMessage: LlmMessage = {
          role: 'tool',
          content: JSON.stringify(result),
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        }
        messages.push(toolMessage)
        // R3.2: notify onMessage for the tool result message.
        await notify({
          role: 'tool',
          content: toolMessage.content,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        })
      }
      continue
    }

    // R3.10: no tool_calls — return final answer
    verbose(`llm:response [iter=${i}] final`, response.content.slice(0, 200))
    // R3.2: notify onMessage for the final assistant turn (no tool calls).
    await notify({ role: 'assistant', content: response.content })
    return response.content
  }

  // R3.8: max iterations reached — return last model content
  return messages[messages.length - 1]?.content ?? ''
}
