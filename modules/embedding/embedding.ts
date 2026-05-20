// Thin wrapper around the @guildbot/llm `embed()` API. Kept as a separate module
// so callers don't need to import the LLM module directly for a single-purpose
// operation, and so we can keep a stable signature here if `embed()` evolves.
import { embed } from '@guildbot/llm'

export const getEmbedding = async (text: string, model?: string): Promise<number[]> => {
  return embed(text, { model })
}
