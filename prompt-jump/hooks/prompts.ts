import type { Prompt } from '../types'

// The transcript file stores a prompt typed at the terminal on a row that
// carries this, and no other row does: grep picks those rows out of a file
// that can run past the 4 MiB one read may copy.
export const TYPED = '"origin":{"kind":"human"}'

// The file stores each block of Claude's reply on a row of its own, and a
// text block's row holds this.
export const REPLY = '"role":"assistant","content":[{"type":"text"'

// The conversation reads at most its newest LIMIT rows.
export const LIMIT = 4096

// A slash command's record: the chat draws it as the command, not as a prompt.
const COMMAND = /^\s*<(command-name|command-message|local-command-)/
// The tags a paste is stored between, which the chat doesn't show.
const PASTE = /<\/?pasted_content[^>]*>/g

type Block = { type?: unknown; text?: unknown }

type Row = {
  type?: unknown
  uuid?: unknown
  timestamp?: unknown
  isMeta?: unknown
  isSidechain?: unknown
  isCompactSummary?: unknown
  isApiErrorMessage?: unknown
  origin?: { kind?: unknown }
  message?: { model?: unknown; content?: unknown }
}

// The row's text blocks joined, or undefined for a row that holds a tool's
// result (the answer to a tool call, not a prompt).
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return undefined
  }

  const blocks = content as Block[]
  if (blocks.some(block => block.type === 'tool_result')) {
    return undefined
  }

  return blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}

// Reads the prompts the person typed from the transcript file's lines that
// carry TYPED, oldest first, numbered from 1 in the order they were sent.
export function parsePrompts(lines: string): Prompt[] {
  const prompts: Prompt[] = []
  for (const line of lines.split('\n')) {
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      continue
    }
    if (
      row.type !== 'user' ||
      row.origin?.kind !== 'human' ||
      row.isMeta === true ||
      row.isSidechain === true ||
      row.isCompactSummary === true ||
      typeof row.uuid !== 'string'
    ) {
      continue
    }

    const text = textOf(row.message?.content)
    if (text === undefined || text.trim() === '' || COMMAND.test(text)) {
      continue
    }

    const sentAt = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    prompts.push({
      id: row.uuid,
      number: prompts.length + 1,
      text,
      ...(Number.isFinite(sentAt) ? { sentAt } : {}),
    })
  }

  return prompts
}

// The id of the newest row of text Claude wrote, from the transcript file's
// lines that hold REPLY; undefined when there is none. An API error and the
// engine's own stand-in replies are written as Claude's, but not by Claude.
export function lastReply(lines: string): string | undefined {
  for (const line of lines.split('\n').reverse()) {
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      continue
    }
    if (
      row.type === 'assistant' &&
      row.isSidechain !== true &&
      row.isApiErrorMessage !== true &&
      row.message?.model !== '<synthetic>' &&
      typeof row.uuid === 'string' &&
      (textOf(row.message?.content) ?? '').trim() !== ''
    ) {
      return row.uuid
    }
  }

  return undefined
}

// What two copies of one prompt's text share, however their blocks were joined.
function keyOf(text: string): string {
  return text.replace(/\s+/g, '')
}

// The prompts the conversation still holds, oldest first: those are the rows
// the chat draws, as a compaction folds the turns before it into a summary
// and a rewind drops the turns after it. The conversation's rows carry no
// ids, so a prompt is matched to a user row by its text, newest first: of
// two prompts with one text the newer is kept, and a rewound prompt sent
// again is the older. When the conversation is longer than the newest
// LIMIT rows it reads, the prompts older than the matched ones are kept too.
export function inConversation(prompts: readonly Prompt[], rows: readonly { role: string; text: string }[]): Prompt[] {
  const left = new Map<string, number>()
  for (const row of rows) {
    if (row.role === 'user') {
      const key = keyOf(row.text)
      left.set(key, (left.get(key) ?? 0) + 1)
    }
  }

  const kept: Prompt[] = []
  for (const prompt of [...prompts].reverse()) {
    const key = keyOf(prompt.text)
    const count = left.get(key) ?? 0
    if (count > 0) {
      left.set(key, count - 1)
      kept.push(prompt)
    }
  }

  if (rows.length >= LIMIT) {
    const oldest = kept.at(-1)?.number ?? Infinity
    kept.push(...prompts.filter(prompt => prompt.number < oldest).reverse())
  }

  return kept.reverse()
}

// The prompt as the chat shows it: a paste's text without its tags.
export function plainOf(text: string): string {
  return text.replace(PASTE, '')
}

export function termsOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(term => term !== '')
}

// The prompts holding every word of the query, in any case, newest first.
export function matching(prompts: readonly Prompt[], query: string): Prompt[] {
  const terms = termsOf(query)

  return prompts
    .filter(prompt => {
      const text = plainOf(prompt.text).toLowerCase()

      return terms.every(term => text.includes(term))
    })
    .reverse()
}

// One line of a prompt, cut to a width, around the query's first word: the
// text before it, the word as typed in the prompt, and the text after.
export type Snippet = { before: string; match: string; after: string }

// How many characters of the line to show before the match when the line
// has to start later for the match to show.
const LEAD = 12

export function snippet(text: string, query: string, width: number): Snippet {
  const lines = plainOf(text)
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line !== '')
  const term = termsOf(query)[0]
  const line = (term === undefined ? undefined : lines.find(one => one.toLowerCase().includes(term))) ?? lines[0] ?? ''
  const lower = line.toLowerCase()
  // A letter whose lower case is longer (İ) would put the match elsewhere.
  const at = term === undefined || lower.length !== line.length ? -1 : lower.indexOf(term)
  if (at < 0) {
    return { before: clip(line, width), match: '', after: '' }
  }

  const end = at + term!.length
  let before = line.slice(0, at)
  if (widthOf(line.slice(0, end)) > width && at > LEAD) {
    before = `…${line.slice(at - LEAD, at)}`
  }
  const match = clip(line.slice(at, end), Math.max(1, width - widthOf(before)))
  const after = match.endsWith('…') ? '' : clip(line.slice(end), width - widthOf(before) - widthOf(match))

  return { before, match, after }
}

// The text cut to `width` columns, an ellipsis ending what was cut.
function clip(text: string, width: number): string {
  if (widthOf(text) <= width) {
    return text
  }
  if (width <= 0) {
    return ''
  }

  let kept = ''
  let used = 0
  for (const ch of text) {
    const w = widthOf(ch)
    if (used + w > width - 1) {
      break
    }
    kept += ch
    used += w
  }

  return `${kept}…`
}

// The columns a text takes in a terminal: East Asian wide letters and emoji
// take two, combining marks none.
export function widthOf(text: string): number {
  let width = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if ((c >= 0x300 && c <= 0x36f) || (c >= 0x200b && c <= 0x200f) || (c >= 0xfe00 && c <= 0xfe0f)) continue
    width += isWide(c) ? 2 : 1
  }

  return width
}

function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f64f) ||
    (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  )
}

// The time a prompt was sent, as HH:MM on the local clock.
export function timeOf(sentAt: number): string {
  const at = new Date(sentAt)

  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
