import {
  AgentStreamEvent,
  AgentWorkflowDefinition,
  runAgentWorkflow,
  validateWorkflowDefinition,
  WorkflowParserJsonOutput,
  type AgentWorkflowResult
} from '@hexafield/agent-workflow'

import os from 'node:os'

export const cldWorkflowDocument = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'cld.v1',
  description: 'Extract causal relationships and node classifications for causal loop diagrams.',
  model: 'github-copilot/gpt-5-mini',
  sessions: {
    roles: [
      { role: 'summariser' as const, nameTemplate: '{{runId}}-cld-summariser' },
      { role: 'extractor' as const, nameTemplate: '{{runId}}-cld-extractor' },
      { role: 'classifier' as const, nameTemplate: '{{runId}}-cld-classifier' },
      { role: 'relator' as const, nameTemplate: '{{runId}}-cld-relator' },
      { role: 'consolidator' as const, nameTemplate: '{{runId}}-cld-consolidator' }
    ]
  },
  parsers: {
    passthrough: { type: 'unknown' as const },
    cld: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              type: { type: 'string', enum: ['driver', 'obstacle', 'actor', 'other'] }
            },
            required: ['label', 'type'],
            additionalProperties: false
          },
          default: []
        },
        relationships: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              object: { type: 'string' },
              predicate: { type: 'string', enum: ['positive', 'negative'] },
              reasoning: { type: 'string' },
              relevant: { type: 'array', items: { type: 'string' }, default: [] },
              createdAt: { type: 'string' }
            },
            required: ['subject', 'object', 'predicate', 'reasoning', 'relevant', 'createdAt'],
            additionalProperties: false
          },
          default: []
        }
      },
      required: ['nodes', 'relationships'],
      additionalProperties: false
    }
  },
  user: { instructions: { type: 'string', default: '' } },
  roles: {
    summariser: {
      systemPrompt: `Summarise the general topic(s) of the provided text in 2-4 short sentences.
- Stay strictly within what the text asserts; no speculation or extrapolation.
- Capture the main subject areas (themes) using concise language.
- Keep the summary scoped to ideas that recur or anchor the text.
Return strict JSON: {"topics": ["..."]} with lowercase entries and no commentary.`,
      parser: 'passthrough'
    },
    extractor: {
      systemPrompt: `From the text, extract a rich set of causal statements the text actually asserts.
Use the provided topics as a relevance filter; skip statements that do not clearly relate to those topics.
- A causal statement should indicate how one factor influences another.
- Exclude speculation, jokes, hypotheticals, opinions about unknowns, or non-causal descriptions.
- Keep statements concise and anchored to the exact meaning in the text span.
Return strict JSON: {"causalStatements": [{"section": "title", "statement": "..."}]} preserving order.`,
      parser: 'passthrough'
    },
    classifier: {
      systemPrompt: `Classify variables involved in the causal statements into one of: driver, obstacle, actor, other.
- driver: external positive influences, generators, attractors, or outcomes/goals.
- obstacle: barriers or friction that steer away from goals.
- actor: people, agents, or processes operating in/through the system.
- other: none of the above.
- Keep variable names concise (max 2 words), neutral tone, lowercase; minimize distinct variables by merging near-duplicates.
Return strict JSON: {"nodes": [{"label": "...", "type": "driver|obstacle|actor|other"}]} with unique labels.`,
      parser: 'passthrough'
    },
    relator: {
      systemPrompt: `Generate relationships linking the causal statements.
- Map each causal statement to subject (cause) and object (effect) variables.
- predicate: "positive" if subject increases object; "negative" if subject decreases object.
- reasoning: brief rationale grounded in the statement.
- relevant: exact supporting span(s) from the text.
- subject/object must match the chosen variable labels (lowercase) from earlier steps.
Only include relationships that align with the provided topics.
Return strict JSON: {"relationships": [{"subject": "...", "predicate": "positive|negative", "object": "...", "reasoning": "...", "relevant": ["..."]}]}. Subject/object lowercase variable names only.`,
      parser: 'passthrough'
    },
    consolidator: {
      systemPrompt: `You are a System Dynamics Professional Modeler.
    Users will give text, and upstream steps have produced topics, causal statements, node types, and relationships. Consolidate into a causal loop diagram dataset where all variables form a single connected graph.

Tasks:
- Merge variables across prior steps, keeping concise (max 2 words), neutral, lowercase labels; minimize distinct variables.
- Ensure every relationship subject/object maps to a node label; drop unsupported items.
- Exclude any nodes that have no relationships.
- If no causal relationships exist, return empty arrays.

Output strict JSON with shape: {"nodes":[{label,type}], "relationships":[{subject,predicate,object,reasoning,relevant,createdAt}]}
- predicate: "positive" or "negative"
- relevant: exact supporting spans
- createdAt: ISO 8601 timestamp set at response time
- type: driver | obstacle | actor | other
No markdown fences or commentary.`,
      parser: 'cld'
    }
  },
  state: {
    initial: {}
  },
  flow: {
    round: {
      start: 'summariser',
      steps: [
        {
          key: 'summariser',
          role: 'summariser' as const,
          next: 'extractor',
          prompt: ['Source text (treat as transcript):\n{{user.instructions}}']
        },
        {
          key: 'extractor',
          role: 'extractor' as const,
          next: 'classifier',
          prompt: [
            'General topics (JSON):\n{{steps.summariser.raw}}',
            'Source text:\n{{user.instructions}}',
            'Extract asserted causal statements only; exclude speculation, jokes, or hypotheticals. Keep only statements tied to the provided topics.'
          ]
        },
        {
          key: 'classifier',
          role: 'classifier' as const,
          next: 'relator',
          prompt: [
            'Causal statements (JSON):\n{{steps.extractor.raw}}',
            'Classify variables into driver | obstacle | actor | other with concise lowercase labels.'
          ]
        },
        {
          key: 'relator',
          role: 'relator' as const,
          next: 'consolidator',
          prompt: [
            'Causal statements (JSON):\n{{steps.extractor.raw}}',
            'Node types (JSON):\n{{steps.classifier.raw}}',
            'Topics (JSON):\n{{steps.summariser.raw}}',
            'Generate directional relationships with predicate positive/negative and supporting spans.'
          ]
        },
        {
          key: 'consolidator',
          role: 'consolidator' as const,
          prompt: [
            'Source text:\n{{user.instructions}}',
            'Topics (JSON):\n{{steps.summariser.raw}}',
            'Causal statements (JSON):\n{{steps.extractor.raw}}',
            'Node types (JSON):\n{{steps.classifier.raw}}',
            'Relationships (JSON):\n{{steps.relator.raw}}',
            'Consolidate into connected nodes and relationships. Return strict JSON only.'
          ],
          exits: [
            {
              condition: 'always',
              outcome: 'completed',
              reason: 'Causal loop diagram data generated'
            }
          ]
        }
      ],
      maxRounds: 1,
      defaultOutcome: {
        outcome: 'completed',
        reason: 'Causal extraction pipeline executed'
      }
    }
  }
} as const satisfies AgentWorkflowDefinition

export type CldWorkflowDefinition = typeof cldWorkflowDocument
export type CldParserOutput = WorkflowParserJsonOutput<(typeof cldWorkflowDocument)['parsers']['cld']>

export const cldWorkflowDefinition = validateWorkflowDefinition(cldWorkflowDocument)
export type CldWorkflowResult = AgentWorkflowResult<CldWorkflowDefinition>

const extractCldOutput = (result: CldWorkflowResult): CldParserOutput | undefined => {
  const lastRound = result.rounds[result.rounds.length - 1]
  return lastRound?.steps?.consolidator?.parsed as CldParserOutput | undefined
}

export async function generateCausalRelationships(
  sentences: string[],
  userPrompt?: string,
  onProgress?: (msg: string) => void
): Promise<CldParserOutput | { error: string }> {
  const workspacePath = os.tmpdir() + `/cld-sessions/session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const onStream = (msg: AgentStreamEvent) => {
    if (!onProgress) return
    switch (msg.step) {
      case 'summariser':
        onProgress(`[CLD] Summarising topics...`)
        break
      case 'extractor':
        onProgress(`[CLD] Extracting causal statements...`)
        break
      case 'classifier':
        onProgress(`[CLD] Classifying nodes...`)
        break
      case 'relator':
        onProgress(`[CLD] Generating relationships...`)
        break
      case 'consolidator':
        onProgress(`[CLD] Consolidating CLD data...`)
        break
    }
  }

  let userInstructions = sentences.join('\n')

  if (userPrompt) {
    userInstructions = `User prompt: ${userPrompt}\n\nSource text:\n${userInstructions}`
  }

  try {
    const response = await runAgentWorkflow(cldWorkflowDefinition, {
      user: { instructions: userInstructions },
      model: 'github-copilot/gpt-5-mini',
      sessionDir: workspacePath,
      workflowId: cldWorkflowDefinition.id,
      workflowSource: 'user',
      workflowLabel: cldWorkflowDefinition.description,
      onStream
    })
    const result = await response.result
    const output = extractCldOutput(result)

    return output!
  } catch (e) {
    return { error: (e as Error).message }
  }
}
