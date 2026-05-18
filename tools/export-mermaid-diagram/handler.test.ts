import { describe, expect, it, vi } from 'vitest'

vi.mock('@guildbot/exporters', () => ({
  exportMermaid: vi.fn().mockResolvedValue({
    outPath: '/tmp/exports/diagram.mdd',
    svgPath: '/tmp/exports/diagram.svg',
    pngPath: '/tmp/exports/diagram.png',
  }),
}))

vi.mock('@guildbot/config', () => ({
  ROOT_DIR: '/tmp',
}))

import handler from './handler'

describe('export-mermaid-diagram handler', () => {
  const nodes = [{ label: 'X', type: 'actor' }]
  const relationships = [{ subject: 'X', object: 'X', predicate: 'negative' }]

  it('returns png and svg paths', async () => {
    const result = await handler({ nodes, relationships }, {})
    expect(result.success).toBe(true)
    expect((result.data as any).png_path).toBe('/tmp/exports/diagram.png')
    expect((result.data as any).svg_path).toBe('/tmp/exports/diagram.svg')
  })

  it('passes correct args to exportMermaid', async () => {
    const { exportMermaid } = await import('@guildbot/exporters')
    await handler({ nodes, relationships }, {})
    expect(exportMermaid).toHaveBeenCalledWith(
      expect.stringContaining('exports'),
      'diagram',
      nodes,
      relationships,
    )
  })
})
