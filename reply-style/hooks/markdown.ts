// Markdown as Claude writes it, read into blocks and styled runs. Not full
// CommonMark: what replies use, read leniently, so a reply that is still
// streaming (a fence not yet closed, a table half written) draws too.

export type Align = 'left' | 'center' | 'right'

export type Alert = 'note' | 'tip' | 'important' | 'warning' | 'caution'

export type Item = { task?: 'todo' | 'done'; blocks: Block[] }

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; lang: string; source: string }
  | { kind: 'copy'; label: string; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] }
  | { kind: 'quote'; alert?: Alert; blocks: Block[] }
  | { kind: 'list'; start?: number; items: Item[] }

// A block with a copy button: code, or text to paste elsewhere.
export type Copyable = Extract<Block, { kind: 'code' | 'copy' }>

// A stretch of inline text in one style: `href` marks a link and `code`
// inline code; `number` and `path` are found in the plain text between them.
export type Run = {
  text: string
  bold?: true
  italic?: true
  strike?: true
  code?: true
  href?: string
  number?: true
  path?: true
}

// How a paragraph's line breaks read: as spaces, as in a reply, or kept, as
// in a command's output, whose lines are often laid out by hand.
export type Breaks = 'space' | 'line'

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)([^`]*)$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|\t|$)(.*)$/
const DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const ALERT = /^\[!(note|tip|important|warning|caution)\][ \t]*$/i
const TASK = /^\[([ xX])\][ \t]+/

// Control characters a drawn text refuses; tab and newline are read here.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

export function parse(text: string, breaks: Breaks = 'space'): Block[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .split('\n')
    .map(line => line.replace(/^\t+/, tabs => '    '.repeat(tabs.length)))

  return blocks(lines, breaks)
}

function blocks(lines: string[], breaks: Breaks): Block[] {
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === '') {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const [, indent, mark, lang, rest] = fence as unknown as [string, string, string, string, string]
      const close = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`)
      const body: string[] = []
      for (i++; i < lines.length && !close.test(lines[i]!); i++) {
        body.push(lines[i]!.replace(new RegExp(`^ {0,${indent.length}}`), ''))
      }
      i++
      // `copy` and a label mark text the person pastes elsewhere, such as
      // a message drafted for them (the rule in `copy.ts`).
      out.push(
        lang.toLowerCase() === 'copy'
          ? { kind: 'copy', label: rest.trim(), text: body.join('\n') }
          : { kind: 'code', lang, source: body.join('\n') },
      )
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ kind: 'heading', level: heading[1]!.length, text: heading[2] ?? '' })
      i++
      continue
    }

    if (RULE.test(line)) {
      out.push({ kind: 'rule' })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const inner: string[] = []
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) {
        inner.push(QUOTE.exec(lines[i]!)![1]!)
      }
      const alert = ALERT.exec(inner[0] ?? '')
      out.push(
        alert
          ? { kind: 'quote', alert: alert[1]!.toLowerCase() as Alert, blocks: blocks(inner.slice(1), breaks) }
          : { kind: 'quote', blocks: blocks(inner, breaks) },
      )
      continue
    }

    if (isTable(lines, i)) {
      const head = cells(line)
      const align = cells(lines[i + 1]!).map(alignOf)
      const rows: string[][] = []
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== ''; i++) {
        rows.push(fit(cells(lines[i]!), head.length, ''))
      }
      out.push({ kind: 'table', head, align, rows })
      continue
    }

    if (ITEM.test(line)) {
      const [list, next] = parseList(lines, i, breaks)
      out.push(list)
      i = next
      continue
    }

    const paragraph = [line]
    for (i++; i < lines.length && lines[i]!.trim() !== '' && !startsBlock(lines, i); i++) {
      paragraph.push(lines[i]!)
    }
    out.push({ kind: 'paragraph', text: join(paragraph, breaks) })
  }

  return out
}

// The blocks with a copy button, in the order they are drawn, inside lists
// and quotes too.
export function copyables(blocks: Block[]): Copyable[] {
  return blocks.flatMap(block =>
    block.kind === 'code' || block.kind === 'copy'
      ? [block]
      : block.kind === 'quote'
        ? copyables(block.blocks)
        : block.kind === 'list'
          ? copyables(block.items.flatMap(item => item.blocks))
          : [],
  )
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!

  return (
    FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || isTable(lines, i)
  )
}

// A header row of cells, then a delimiter row with as many.
function isTable(lines: string[], i: number): boolean {
  const next = lines[i + 1]

  return (
    lines[i]!.includes('|') &&
    next !== undefined &&
    DELIMITER.test(next) &&
    cells(next).length === cells(lines[i]!).length
  )
}

// A row's cells, split at each pipe not escaped, the outer pipes dropped.
function cells(line: string): string[] {
  const row = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')

  return row.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
}

function alignOf(delimiter: string): Align {
  const left = delimiter.startsWith(':')
  const right = delimiter.endsWith(':')

  return left && right ? 'center' : right ? 'right' : 'left'
}

function fit<T>(row: T[], length: number, fill: T): T[] {
  return Array.from({ length }, (_, n) => row[n] ?? fill)
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

// A list and the line after it. An item holds the lines indented to its
// text, any item indented deeper than its own marker (a nested list, even
// one indented less than the text, as Claude often writes under `1.`), and
// lines that carry on its paragraph unindented.
function parseList(lines: string[], from: number, breaks: Breaks): [Block, number] {
  const first = ITEM.exec(lines[from]!)!
  const indent = first[1]!.length
  const isOrdered = /\d/.test(first[2]!)
  const isSibling = (line: string | undefined) => {
    const item = line === undefined || RULE.test(line) ? null : ITEM.exec(line)

    return item !== null && item[1]!.length === indent && /\d/.test(item[2]!) === isOrdered
  }

  const items: Item[] = []
  let i = from
  while (isSibling(lines[i])) {
    const [, , marker, gap, text] = ITEM.exec(lines[i]!) as unknown as [string, string, string, string, string]
    const column = indent + marker.length + Math.min(Math.max(gap.length, 1), 4)
    const body = [text]
    for (i++; i < lines.length; ) {
      const line = lines[i]!
      if (line.trim() === '') {
        let k = i
        while (k < lines.length && lines[k]!.trim() === '') k++
        if (k < lines.length && indentOf(lines[k]!) >= column) {
          for (; i < k; i++) body.push('')
          continue
        }
        break
      }

      const depth = indentOf(line)
      const isItem = ITEM.test(line) && !RULE.test(line)
      if (depth >= column || (isItem && depth > indent)) {
        body.push(line.slice(Math.min(depth, column)))
        i++
        continue
      }
      if (isItem || (depth <= indent && startsBlock(lines, i))) break
      body.push(line.trim())
      i++
    }

    const task = TASK.exec(body[0]!)
    if (task) body[0] = body[0]!.slice(task[0].length)
    items.push({ ...(task ? { task: task[1] === ' ' ? 'todo' : 'done' } : {}), blocks: blocks(body, breaks) })

    // Blank lines between this item and the next.
    let k = i
    while (k < lines.length && lines[k]!.trim() === '') k++
    if (isSibling(lines[k])) i = k
  }

  return [{ kind: 'list', ...(isOrdered ? { start: Number(first[2]!.slice(0, -1)) } : {}), items }, i]
}

function join(lines: string[], breaks: Breaks): string {
  if (breaks === 'line') return lines.map(line => line.trimEnd()).join('\n')

  return lines
    .map((line, n) => {
      if (n === lines.length - 1) return line.trim()
      const isHard = / {2,}$/.test(line) || /\\$/.test(line.trimEnd())

      return line.trim().replace(/\\$/, '') + (isHard ? '\n' : ' ')
    })
    .join('')
}

type Style = Omit<Run, 'text' | 'number' | 'path'>

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~<>"'$&]/
const LINK = /^\[((?:\\.|[^\\[\]]|\[[^\]]*\])*)\]\(\s*<?([^\s<>()]*(?:\([^\s<>()]*\)[^\s<>()]*)*)>?(?:\s+["'][^"']*["'])?\s*\)/
const AUTOLINK = /^<((?:https?|mailto):[^\s<>]+)>/
const URL = /^https?:\/\/[^\s<>"'`]+/

// Paths: `~/`, `./` and `../` ones, absolute ones of two names or more (so
// `/config` stays a command), and relative ones ending in a file's extension.
const PATH =
  /(?<![\w./~:@%+-])(?:(?:~|\.\.?)\/[\w.@%+-][\w.@%+/-]*|\/[\w.@%+-]+\/[\w.@%+/-]*|[\w@%+-][\w.@%+-]*(?:\/[\w.@%+-]+)+\.[A-Za-z][A-Za-z0-9]{0,9}(?![\w/]))/g

// Numbers: dates, issue numbers, amounts, versions, and counts with a unit
// (`250ms`, `3m`, `1.2k`, `16GB`, `99.9%`); never digits inside a word
// (`x86`), nor the start of a number with a unit it doesn't know.
const NUMBER =
  /(?<![\w.#$-])(?:\d{4}-\d{2}-\d{2}|#\d+|\$\d+(?:[.,]\d+)*|v\d+(?:\.\d+)+(?:-[\w.]+)?|\d+(?:[.,:]\d+)*(?:%|ms|min|[smhdw]|[kKMGT]i?B?|B|x)?)(?![\w%]|[.,:]\d)/g

export function inline(text: string): Run[] {
  const out: Run[] = []
  spans(text.replace(/\t/g, '    ').replace(CONTROL, ''), {}, out)

  return out
}

function spans(s: string, style: Style, out: Run[]): void {
  let plain = ''
  const flush = () => {
    if (plain !== '') words(plain, style, out)
    plain = ''
  }

  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '\\' && ESCAPABLE.test(s[i + 1] ?? '')) {
      plain += s[i + 1]
      i += 2
      continue
    }

    if (c === '`') {
      const n = runOf(s, i, '`')
      const close = closingTicks(s, i + n, n)
      if (close !== -1) {
        flush()
        push(out, { ...style, code: true, text: codeText(s.slice(i + n, close)) })
        i = close + n
      } else {
        plain += s.slice(i, i + n)
        i += n
      }
      continue
    }

    // `**bold**`, `*italic*`, `***both***` (or with `_`), `~~struck~~`.
    if (c === '*' || c === '_' || c === '~') {
      const n = runOf(s, i, c)
      const isDelimiter = c === '~' ? n === 2 : n <= 3
      const close = isDelimiter && opens(s, i, n, c) ? closing(s, i + n, n, c) : -1
      if (close !== -1) {
        flush()
        const inner: Style =
          c === '~'
            ? { ...style, strike: true }
            : n === 3
              ? { ...style, bold: true, italic: true }
              : n === 2
                ? { ...style, bold: true }
                : { ...style, italic: true }
        spans(s.slice(i + n, close), inner, out)
        i = close + n
      } else {
        plain += s.slice(i, i + n)
        i += n
      }
      continue
    }

    const isImage = c === '!' && s[i + 1] === '['
    const link = c === '[' || isImage ? LINK.exec(s.slice(isImage ? i + 1 : i)) : null
    if (link && style.href === undefined) {
      flush()
      const [whole, label, href] = link as unknown as [string, string, string]
      if (label === '') push(out, { ...style, href, text: href })
      else spans(label, { ...style, href }, out)
      i += whole.length + (isImage ? 1 : 0)
      continue
    }

    const auto = c === '<' && style.href === undefined ? AUTOLINK.exec(s.slice(i)) : null
    if (auto) {
      flush()
      push(out, { ...style, href: auto[1]!, text: auto[1]! })
      i += auto[0].length
      continue
    }

    if (c === 'h' && style.href === undefined && !/\w/.test(s[i - 1] ?? '') && URL.test(s.slice(i))) {
      flush()
      const url = bareUrl(s.slice(i))
      push(out, { ...style, href: url, text: url })
      i += url.length
      continue
    }

    plain += c
    i++
  }
  flush()
}

function runOf(s: string, at: number, c: string): number {
  let n = 0
  while (s[at + n] === c) n++

  return n
}

function closingTicks(s: string, from: number, n: number): number {
  for (let j = from; j < s.length; ) {
    if (s[j] !== '`') {
      j++
      continue
    }
    const length = runOf(s, j, '`')
    if (length === n) return j
    j += length
  }

  return -1
}

// A code span's text: a space at each end dropped when both are there.
function codeText(text: string): string {
  const flat = text.replace(/\n/g, ' ')

  return /^ .*[^ ].* $/.test(flat) ? flat.slice(1, -1) : flat
}

function isAlnum(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}]/u.test(c)
}

function opens(s: string, at: number, n: number, c: string): boolean {
  const after = s[at + n]
  if (after === undefined || /\s/.test(after)) return false

  return c !== '_' || !isAlnum(s[at - 1])
}

// Where a run of `n` delimiters closes the one opened before `from`, past
// code spans and escapes; -1 when nothing closes it. A longer run closes it
// with its last `n` when the rest closes an emphasis left open inside, as
// in `**bold *both***`.
function closing(s: string, from: number, n: number, c: string): number {
  for (let j = from; j < s.length; ) {
    const ch = s[j]!
    if (ch === '\\') {
      j += 2
      continue
    }
    if (ch === '`') {
      const ticks = runOf(s, j, '`')
      const close = closingTicks(s, j + ticks, ticks)
      j = close === -1 ? j + ticks : close + ticks
      continue
    }
    if (ch !== c) {
      j++
      continue
    }
    const length = runOf(s, j, c)
    const canClose = j > from && !/\s/.test(s[j - 1]!) && (c !== '_' || !isAlnum(s[j + length]))
    if (canClose && length === n) return j
    if (canClose && length > n && isOpenInside(s.slice(from, j), c, length - n)) return j + length - n
    j += length
  }

  return -1
}

// Whether a text holds an odd number of runs of exactly `n` delimiters: one
// of them opened and is not closed.
function isOpenInside(text: string, c: string, n: number): boolean {
  let count = 0
  for (let j = 0; j < text.length; ) {
    const length = runOf(text, j, c)
    if (length === n) count++
    j += Math.max(length, 1)
  }

  return count % 2 === 1
}

// A bare URL, less the punctuation that ends the sentence around it and a
// closing bracket it did not open.
function bareUrl(s: string): string {
  let url = URL.exec(s)![0]
  for (;;) {
    const trimmed = url.replace(/[.,:;!?*_~]+$/, '')
    const last = trimmed.at(-1)
    const pair = last === ')' ? '(' : last === ']' ? '[' : undefined
    if (pair !== undefined && trimmed.split(last!).length > trimmed.split(pair).length) {
      url = trimmed.slice(0, -1)
      continue
    }

    return trimmed
  }
}

// Plain text, with its paths and numbers in runs of their own.
function words(text: string, style: Style, out: Run[]): void {
  if (style.href !== undefined) {
    push(out, { ...style, text })
    return
  }

  let at = 0
  for (const match of text.matchAll(PATH)) {
    const path = match[0].replace(/\.+$/, '')
    numbers(text.slice(at, match.index), style, out)
    push(out, { ...style, path: true, text: path })
    at = match.index + path.length
  }
  numbers(text.slice(at), style, out)
}

function numbers(text: string, style: Style, out: Run[]): void {
  let at = 0
  for (const match of text.matchAll(NUMBER)) {
    push(out, { ...style, text: text.slice(at, match.index) })
    push(out, { ...style, number: true, text: match[0] })
    at = match.index + match[0].length
  }
  push(out, { ...style, text: text.slice(at) })
}

// Adds a run, joined to the one before when they share a style.
function push(out: Run[], run: Run): void {
  if (run.text === '') return
  const last = out.at(-1)
  if (last !== undefined && sameStyle(last, run)) last.text += run.text
  else out.push({ ...run })
}

function sameStyle(a: Run, b: Run): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strike === b.strike &&
    a.code === b.code &&
    a.href === b.href &&
    a.number === b.number &&
    a.path === b.path
  )
}

// Columns a text takes in a terminal: two for East Asian wide letters and
// emoji, none for combining marks, joiners and variation selectors.
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

// Runs as lines no wider than `width`, broken at spaces, and inside a word
// only when it is wider than a line, as Japanese and Chinese text is.
export function wrap(runs: Run[], width: number): Run[][] {
  const lines: Run[][] = [[]]
  let used = 0
  const add = (run: Run, text: string) => {
    push(lines.at(-1)!, { ...run, text })
    used += widthOf(text)
  }
  const newLine = () => {
    lines.push([])
    used = 0
  }

  // The word being read, across runs, and the space before it.
  let word: { run: Run; text: string }[] = []
  let wordWidth = 0
  let space: Run | undefined
  const place = () => {
    if (word.length === 0) return
    const gap = space !== undefined && used > 0 ? 1 : 0
    if (used > 0 && used + gap + wordWidth > width) newLine()
    else if (gap === 1) add(space!, ' ')

    const fits = wordWidth <= width - used
    for (const part of word) {
      if (fits) {
        add(part.run, part.text)
        continue
      }
      for (const ch of part.text) {
        if (used > 0 && used + widthOf(ch) > width) newLine()
        add(part.run, ch)
      }
    }
    word = []
    wordWidth = 0
    space = undefined
  }

  for (const run of runs) {
    for (const piece of run.text.split(/(\n| +)/)) {
      if (piece === '') continue
      if (piece === '\n') {
        place()
        newLine()
        space = undefined
      } else if (piece.startsWith(' ')) {
        place()
        space = run
      } else {
        word.push({ run, text: piece })
        wordWidth += widthOf(piece)
      }
    }
  }
  place()

  return lines
}
