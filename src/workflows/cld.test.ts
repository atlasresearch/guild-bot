import { expect, test } from 'vitest'
import { generateCausalRelationships } from './cld.workflow'

// Increase timeout because real model calls can take longer
test('generateCausalRelationships', async () => {
  // Larger prompt to exercise CLD parsing
  const largePrompt = `Engineers compare the work remaining to be done against the time remaining before the deadline. The larger the gap, the more Schedule Pressure they feel. When schedule pressure builds up, engineers can work overtime which increases completion rate but also increases fatigue, which lowers productivity.`

  // Expected causal pairs implied by the prompt. Use keyword sets for fuzzy matching.
  const expectedKeywordPairs: Array<[string[], string[]]> = [
    [
      ['gap between work remaining', 'gap', 'work remaining', 'work_remaining', 'workremaining'],
      ['schedule pressure', 'schedule_pressure', 'schedulepressure']
    ],
    [
      ['schedule pressure', 'schedule_pressure'],
      ['overtime', 'working overtime', 'work overtime', 'engineers work overtime']
    ],
    [
      ['overtime', 'working overtime'],
      ['completion rate', 'completion_rate', 'increased completion rate', 'completionrate']
    ],
    [['overtime', 'working overtime'], ['fatigue']],
    [['fatigue'], ['productivity', 'lowered productivity', 'productivity']]
  ]

  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/["'()\.,]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

  // Run the full CLD extraction 5 times in a row and require validity each time
  // for (let i = 0; i < 5; i++) {
  const result = await generateCausalRelationships([largePrompt])
  console.log(result)

  if ('error' in result) {
    throw new Error(`CLD generation failed: ${result.error}`)
  }

  // Expect a non-empty response and structured nodes/relationships
  expect(result).toBeDefined()
  expect(Array.isArray(result.nodes)).toBe(true)
  expect(Array.isArray(result.relationships)).toBe(true)
  expect(result.relationships.length).toBeGreaterThan(0)

  const parsed = result.relationships.map((r: any) => {
    return {
      subject: norm(String(r.subject || '')),
      object: norm(String(r.object || '')),
      predicate: String(r.predicate || '')
    }
  })

  // Ensure every produced relationship has a predicate of 'positive' or 'negative'
  for (const p of parsed) {
    expect(['positive', 'negative']).toContain(p.predicate)
  }

  let found = 0
  for (const [causeKeys, effectKeys] of expectedKeywordPairs) {
    const ok = parsed.some((p: { subject: string; object: string; predicate: string }) => {
      const left = p.subject
      const right = p.object
      const causeOk = causeKeys.some((k) => left.includes(k))
      const effectOk = effectKeys.some((k) => right.includes(k))
      return causeOk && effectOk
    })
    if (ok) found++
  }

  // Require that the model produced most of the expected causal links (tolerate 1 missing) for each run
  expect(found).toBeGreaterThanOrEqual(expectedKeywordPairs.length - 1)
  // }

  console.log('test finished')
}, 600_000)
