import { describe, expect, it, vi } from 'vitest'

vi.mock('@guildbot/media', () => ({
  toKumuJSON: vi.fn().mockReturnValue({ elements: [], connections: [] }),
}))

vi.mock('@guildbot/exporters', () => ({
  exportGraphJSON: vi.fn().mockResolvedValue({ jsonPath: '/tmp/exports/graph.json' }),
}))

vi.mock('@guildbot/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/config')>()
  return { ...actual, EXPORTS_DIR: '/tmp/exports' }
})

import handler from './handler'

describe('export-kumu-json handler', () => {
  const nodes = [{ label: 'A', type: 'driver' }, { label: 'B', type: 'obstacle' }]
  const relationships = [{ subject: 'A', object: 'B', predicate: 'positive' }]

  it('returns file_path and kumu data', async () => {
    const result = await handler({ nodes, relationships }, {})
    expect(result.success).toBe(true)
    expect((result.data as any).file_path).toBe('/tmp/exports/graph.json')
    expect((result.data as any).kumu).toEqual({ elements: [], connections: [] })
  })

  it('passes nodes and relationships to toKumuJSON', async () => {
    const { toKumuJSON } = await import('@guildbot/media')
    await handler({ nodes, relationships }, {})
    expect(toKumuJSON).toHaveBeenCalledWith(nodes, relationships)
  })
})
