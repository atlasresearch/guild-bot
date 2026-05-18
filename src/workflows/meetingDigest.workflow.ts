// TODO: Reimplement meeting digest workflow without @hexafield/agent-workflow

export type MeetingDigestParserOutput = {
  insights: Array<{ summary: string; evidence?: string[] }>
  actionItems: Array<{ task: string; owner?: string; due?: string; status?: string; source?: string }>
  decisions: Array<{ decision: string; rationale?: string; source?: string }>
  openQuestions: Array<{ question: string; owner?: string; source?: string }>
}

export async function generateMeetingDigest(
  transcriptLines: string[],
  userPrompt: string | undefined,
  onProgress?: (msg: string) => void,
  model?: string,
  sessionId?: string,
  sessionDir?: string
): Promise<MeetingDigestParserOutput> {
  console.warn('[Digest] Meeting digest workflow is not yet reimplemented — returning empty result')
  onProgress?.('[Digest] Workflow not yet reimplemented')
  return { insights: [], actionItems: [], decisions: [], openQuestions: [] }
}
