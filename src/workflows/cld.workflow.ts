// TODO: Reimplement causal loop diagram workflow without @hexafield/agent-workflow

export type CldParserOutput = {
  nodes: Array<{ label: string; type: 'driver' | 'obstacle' | 'actor' | 'other' }>
  relationships: Array<{
    subject: string
    object: string
    predicate: 'positive' | 'negative'
    reasoning: string
    relevant: string[]
    createdAt: string
  }>
}

export async function generateCausalRelationships(
  sentences: string[],
  userPrompt?: string,
  onProgress?: (msg: string) => void
): Promise<CldParserOutput | { error: string }> {
  console.warn('[CLD] Causal loop diagram workflow is not yet reimplemented — returning empty result')
  onProgress?.('[CLD] Workflow not yet reimplemented')
  return { nodes: [], relationships: [] }
}
