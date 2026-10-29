import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractLinks,
  extractUrlsFromText,
  formatLinks,
  LINK_COLUMNS,
  linksToCSV,
  linksToJSON,
  sortLinkRows,
  writeLinks,
  type LinkRow
} from './index'

function row(over: Partial<LinkRow>): LinkRow {
  return {
    url: 'https://example.com',
    kind: 'content',
    guildId: '100000000000000001',
    channelId: '200000000000000001',
    channelName: 'general',
    parentChannelName: '',
    messageId: '300000000000000001',
    messageUrl: 'https://discord.com/channels/100000000000000001/200000000000000001/300000000000000001',
    authorId: '400000000000000001',
    authorName: 'alice',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...over
  }
}

describe('extractUrlsFromText', () => {
  it('finds plain URLs', () => {
    expect(extractUrlsFromText('see https://example.com/a?b=1#c now')).toEqual(['https://example.com/a?b=1#c'])
    expect(extractUrlsFromText('http://example.org')).toEqual(['http://example.org'])
  })

  it('unwraps embed-suppressed <url>', () => {
    expect(extractUrlsFromText('quiet <https://example.com/x> please')).toEqual(['https://example.com/x'])
  })

  it('takes the target of markdown [text](url) links', () => {
    expect(extractUrlsFromText('read [the docs](https://docs.example.com/guide) first')).toEqual([
      'https://docs.example.com/guide'
    ])
    expect(extractUrlsFromText('[https://shown.example](https://real.example/path)')).toEqual([
      'https://shown.example',
      'https://real.example/path'
    ])
    expect(extractUrlsFromText('[a](https://example.com/a).')).toEqual(['https://example.com/a'])
  })

  it('strips trailing sentence punctuation', () => {
    expect(extractUrlsFromText('Go to https://example.com.')).toEqual(['https://example.com'])
    expect(extractUrlsFromText('https://example.com/a, https://example.com/b; https://example.com/c!')).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c'
    ])
    expect(extractUrlsFromText('is it https://example.com/q?')).toEqual(['https://example.com/q'])
    expect(extractUrlsFromText("'https://example.com/quoted'")).toEqual(['https://example.com/quoted'])
    expect(extractUrlsFromText('**https://example.com/bold**')).toEqual(['https://example.com/bold'])
  })

  it('keeps balanced parentheses and drops an unbalanced closer', () => {
    const wiki = 'https://en.wikipedia.org/wiki/Mercury_(planet)'
    expect(extractUrlsFromText(`about ${wiki} here`)).toEqual([wiki])
    expect(extractUrlsFromText(`about ${wiki}.`)).toEqual([wiki])
    expect(extractUrlsFromText(`(see ${wiki})`)).toEqual([wiki])
    expect(extractUrlsFromText('(see https://example.com/x).')).toEqual(['https://example.com/x'])
    expect(extractUrlsFromText(`[Mercury](${wiki})`)).toEqual([wiki])
  })

  it('finds several URLs in one message, in order', () => {
    expect(extractUrlsFromText('one https://a.example two <https://b.example>\nthree [c](https://c.example)')).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example'
    ])
  })

  it('finds nothing in text without URLs', () => {
    expect(extractUrlsFromText('')).toEqual([])
    expect(extractUrlsFromText('no links here, just example.com and ftp://files.example')).toEqual([])
    expect(extractUrlsFromText('https:// is a scheme, http://. is not a host')).toEqual([])
    expect(extractUrlsFromText('the word https alone')).toEqual([])
  })
})

describe('extractLinks', () => {
  it('collects content, embed and attachment URLs with their kind', () => {
    const links = extractLinks({
      content: 'look https://example.com/post',
      embeds: [{ url: 'https://embed.example/card' }, { url: null }, {}],
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/file.png' }]
    })
    expect(links).toEqual([
      { url: 'https://example.com/post', kind: 'content' },
      { url: 'https://embed.example/card', kind: 'embed' },
      { url: 'https://cdn.discordapp.com/attachments/1/2/file.png', kind: 'attachment' }
    ])
  })

  it('accepts Map values as attachments (discord.js Collection)', () => {
    const attachments = new Map([['1', { url: 'https://cdn.example/a.txt' }]])
    expect(extractLinks({ content: null, attachments: attachments.values() })).toEqual([
      { url: 'https://cdn.example/a.txt', kind: 'attachment' }
    ])
  })

  it('dedupes exact repeats of a URL within one message, keeping the first', () => {
    const links = extractLinks({
      content: 'https://example.com/a and again https://example.com/a and <https://example.com/b>',
      embeds: [{ url: 'https://example.com/a' }, { url: 'https://example.com/c' }]
    })
    expect(links).toEqual([
      { url: 'https://example.com/a', kind: 'content' },
      { url: 'https://example.com/b', kind: 'content' },
      { url: 'https://example.com/c', kind: 'embed' }
    ])
  })

  it('returns nothing for a message without links', () => {
    expect(extractLinks({ content: 'hello there', embeds: [], attachments: [] })).toEqual([])
  })
})

describe('link writers', () => {
  const older = row({ url: 'https://old.example', messageId: '300000000000000001', timestamp: '2021-05-01T10:00:00.000Z' })
  const newer = row({ url: 'https://new.example', messageId: '300000000000000009', timestamp: '2023-02-01T10:00:00.000Z' })
  const sameTimeLater = row({
    url: 'https://tie.example',
    messageId: '300000000000000005',
    timestamp: '2021-05-01T10:00:00.000Z'
  })

  it('sorts oldest first, tie-breaking by message id and keeping per-message order', () => {
    const a = row({ url: 'https://m.example/1', messageId: '300000000000000007', timestamp: '2022-01-01T00:00:00.000Z' })
    const b = row({ url: 'https://m.example/2', messageId: '300000000000000007', timestamp: '2022-01-01T00:00:00.000Z' })
    const sorted = sortLinkRows([newer, a, sameTimeLater, b, older])
    expect(sorted.map((r) => r.url)).toEqual([
      'https://old.example',
      'https://tie.example',
      'https://m.example/1',
      'https://m.example/2',
      'https://new.example'
    ])
  })

  it('writes CSV with a header, sorted rows and RFC 4180 quoting', () => {
    const tricky = row({
      url: 'https://example.com/?a=1,2',
      channelName: 'news, "breaking"',
      authorName: 'multi\nline',
      timestamp: '2020-01-01T00:00:00.000Z'
    })
    const csv = linksToCSV([newer, tricky])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(LINK_COLUMNS.join(','))
    expect(lines[0]).toBe(
      'url,kind,guildId,channelId,channelName,parentChannelName,messageId,messageUrl,authorId,authorName,timestamp'
    )
    expect(csv).toContain('"https://example.com/?a=1,2",content,')
    expect(csv).toContain(',"news, ""breaking""",')
    expect(csv).toContain(',"multi\nline",2020-01-01T00:00:00.000Z\r\n')
    expect(csv.indexOf('https://example.com/?a=1,2')).toBeLessThan(csv.indexOf('https://new.example'))
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(linksToCSV([])).toBe(LINK_COLUMNS.join(',') + '\r\n')
  })

  it('writes a JSON array of rows with every column, oldest first', () => {
    const parsed = JSON.parse(linksToJSON([newer, older]))
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toEqual([older, newer])
    expect(Object.keys(parsed[0])).toEqual([...LINK_COLUMNS])
    expect(JSON.parse(linksToJSON([]))).toEqual([])
  })

  it('chooses the format from the output extension', () => {
    expect(formatLinks([older], 'out/links.json')).toBe(linksToJSON([older]))
    expect(formatLinks([older], 'out/LINKS.JSON')).toBe(linksToJSON([older]))
    expect(formatLinks([older], 'out/links.csv')).toBe(linksToCSV([older]))
    expect(formatLinks([older], 'out/links.txt')).toBe(linksToCSV([older]))
    expect(formatLinks([older], 'out/links')).toBe(linksToCSV([older]))
  })

  it('creates missing directories when writing', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'links-export-'))
    try {
      const out = path.join(dir, 'nested', 'exports', 'links.json')
      await writeLinks([newer, older], out)
      expect(JSON.parse(await fsp.readFile(out, 'utf8'))).toEqual([older, newer])
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})
