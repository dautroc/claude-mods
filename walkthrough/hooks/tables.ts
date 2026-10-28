// Tables in an item or its preview, made to fit the pane (as aside does).
//
// The terminal lays a Markdown table out for the whole terminal and draws it
// at its own width up to there, whatever box holds it. Beside the transcript
// the pane is narrower, so a table between the two had every row wrapped at
// the pane's edge. A table that fits stays; a wider one becomes a block per
// row, which wraps like any other text.

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
// Characters the terminal draws two cells wide.
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u

type Table = { indent: string; header: string[]; rows: string[][]; end: number }

export function fitTables(markdown: string, columns: number): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let fence = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const marker = FENCE.exec(line)?.[1]
    if (fence !== '') {
      const closes = marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length
      if (closes && line.trim() === marker) {
        fence = ''
      }
      out.push(line)
      continue
    }
    if (marker !== undefined) {
      fence = marker
      out.push(line)
      continue
    }

    const table = readTable(lines, i)
    if (table === undefined) {
      out.push(line)
      continue
    }
    if (drawnWidth(table) <= columns) {
      out.push(...lines.slice(i, table.end))
    } else {
      if (out.length > 0 && out.at(-1)!.trim() !== '') {
        out.push('')
      }
      out.push(...asBlocks(table))
      if (table.end < lines.length && lines[table.end]!.trim() !== '') {
        out.push('')
      }
    }
    i = table.end - 1
  }

  return out.join('\n')
}

function readTable(lines: readonly string[], start: number): Table | undefined {
  const head = lines[start]!
  const rule = lines[start + 1]
  if (!head.includes('|') || rule === undefined || !RULE.test(rule)) {
    return undefined
  }
  const header = cellsOf(head)
  if (cellsOf(rule).length !== header.length) {
    return undefined
  }

  let end = start + 2
  while (end < lines.length && lines[end]!.trim() !== '' && lines[end]!.includes('|')) {
    end++
  }
  // A row's cells past the header's are dropped, as GitHub's tables do.
  const rows = lines.slice(start + 2, end).map(line => cellsOf(line).slice(0, header.length))

  return { indent: /^\s*/.exec(head)![0], header, rows, end }
}

// The cells of a row, split at each pipe that no backslash escapes.
function cellsOf(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      cell += '\\|'
      i++
    } else if (line[i] === '|') {
      cells.push(cell)
      cell = ''
    } else {
      cell += line[i]
    }
  }
  cells.push(cell)

  const trimmed = cells.map(text => text.trim())
  if (trimmed.length > 1 && trimmed[0] === '') {
    trimmed.shift()
  }
  if (trimmed.length > 1 && trimmed.at(-1) === '') {
    trimmed.pop()
  }

  return trimmed
}

// As the terminal draws it: each column as wide as its widest cell, a space
// either side, and a rule before, between and after the columns.
function drawnWidth(table: Table): number {
  const widths = table.header.map((cell, k) => Math.max(shownWidth(cell), ...table.rows.map(row => shownWidth(row[k] ?? ''))))

  return widths.reduce((sum, width) => sum + width + 3, 1)
}

// Cells the text takes once drawn, leaving out the marks the terminal draws
// none of: an escape's backslash, a code span's backticks, bold's asterisks.
// Every other mark is counted, so a table is never thought narrower than it is.
function shownWidth(markdown: string): number {
  const shown = markdown
    .replace(/\\\|/g, '|')
    .split(/(`[^`]*`)/)
    .map((part, n) => (n % 2 === 1 ? part.slice(1, -1) : part.replace(/\*\*/g, '')))
    .join('')

  let width = 0
  for (const char of shown) {
    width += WIDE.test(char) ? 2 : 1
  }

  return width
}

// A block for each row: its first cell in bold, then each other cell under
// its column's name.
function asBlocks({ indent, header, rows }: Table): string[] {
  const blocks = rows.map(row => {
    const [first = '', ...rest] = row
    const lines = first === '' ? [] : [`**${first.replace(/\*\*/g, '')}**`]
    rest.forEach((cell, k) => {
      if (cell !== '') {
        lines.push(header[k + 1] === '' ? `- ${cell}` : `- ${header[k + 1]}: ${cell}`)
      }
    })

    return lines.map(line => indent + line)
  })

  return blocks.filter(lines => lines.length > 0).flatMap((lines, n) => (n === 0 ? lines : ['', ...lines]))
}
