import { chat, type LlmMessage, type LlmTool } from '@guildbot/llm'
import { discoverSkillDescriptions } from '../skills/discover'
import { discoverToolDefinitions, loadToolHandler } from '../tools/discover'
import type { ToolContext, ToolResult } from '../tools/types'
import { verbose } from '@guildbot/interfaces'

const MAX_ITERATIONS = 5

// Structural shape for messages the loop emits to onMessage(). Matches the
// fields a thread store needs without importing @guildbot/threads.
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
   * its extra fields (id/seq/ts/kind/sourceRef) are ignored by the loop.
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
   * persists the user turn before invoking the loop.
   *
   * If onMessage throws, the loop aborts and propagates the error.
   */
  onMessage?: OnAgentMessage
}

// The loop owns ONLY the skill-list system message. Identity / norms / voice
// live in the guild's prompt.md and are injected as the thread's first
// message (kind: 'guild-prompt') by the dispatcher — see plan 007.
export function buildSystemPrompt(
  skillDescriptions: Array<{ name: string; description: string }>
): string {
  if (skillDescriptions.length === 0) {
    return 'You have access to tools. Use them to answer questions; do not refuse or hallucinate.'
  }
  return `You have access to tools and these skills:
${skillDescriptions.map((s) => `- **${s.name}**: ${s.description}`).join('\n')}

Use tools to answer questions; do not refuse or hallucinate. When you have enough information, respond directly without calling more tools.`
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

  // read from disk at the top of every invocation
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
      // notify onMessage for the assistant turn (which carries the tool calls).
      // errors propagate, aborting the loop.
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
          // append error as tool message and continue
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
        // notify onMessage for the tool result message.
        await notify({
          role: 'tool',
          content: toolMessage.content,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        })
      }
      continue
    }

    // no tool_calls — return final answer
    verbose(`llm:response [iter=${i}] final`, response.content.slice(0, 200))
    // notify onMessage for the final assistant turn (no tool calls).
    await notify({ role: 'assistant', content: response.content })
    return response.content
  }

  // max iterations reached — return last model content
  return messages[messages.length - 1]?.content ?? ''
}
