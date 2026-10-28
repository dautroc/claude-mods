import type { Color, ElementTable, RenderElement } from 'claude-code'

import { type Alert, type Block, type Run, inline, widthOf, wrap } from './markdown'

// Theme keys, so every colour follows the person's /theme, light or dark.
// Numbers and paths take keys no theme here shares with the accent: the
// Mado theme gives `warning` the accent's colour.
const COLOR = {
  accent: 'claude', // H1 and H2, list markers, table headers
  code: 'permission', // inline code, as Claude Code draws it
  link: 'ide',
  number: 'merged',
  path: 'success',
  frame: 'inactive', // table borders, rules, a code block's language
  bar: 'subtle', // the bar beside a quote
  draft: 'suggestion', // the bar beside text to copy, not prompt-style's orange
  done: 'success', // a done task's tick
} as const satisfies Record<string, Color>

const ALERTS: Record<Alert, { label: string; color: Color }> = {
  note: { label: 'Note', color: 'ide' },
  tip: { label: 'Tip', color: 'success' },
  important: { label: 'Important', color: 'merged' },
  warning: { label: 'Warning', color: 'warning' },
  caution: { label: 'Caution', color: 'error' },
}

const BULLETS = ['•', '◦', '▪']

export type Draw = {
  el: ElementTable<'terminal'>
  // Copies a block's text when its button is pressed; `what` names it in
  // the toast that says so.
  copy: (text: string, what: string) => void
  // The code and copy blocks drawn so far, which keys each one's button.
  codes: number
}

// Where a block sits: the columns it has, how deep in lists, and the style
// its text takes on there (a done task's is dim and struck through).
type Place = { columns: number; depth: number; dim?: true; strike?: true }

type TextStyle = { color?: Color; bold?: true }

export function drawBlocks(d: Draw, blocks: Block[], place: Place, gap: 0 | 1 = 1): RenderElement {
  const { Box } = d.el

  return (
    <Box flexDirection="column" rowGap={gap}>
      {blocks.map(block => drawBlock(d, block, place))}
    </Box>
  )
}

function drawBlock(d: Draw, block: Block, place: Place): RenderElement {
  const { Box, Button, Code, Text } = d.el
  switch (block.kind) {
    case 'paragraph':
      return <Text>{drawRuns(d, inline(block.text), place)}</Text>

    case 'heading': {
      const runs = inline(block.text)
      if (block.level >= 3) return <Text>{drawRuns(d, runs, place, { bold: true })}</Text>
      const title = <Text>{drawRuns(d, runs, place, { bold: true, color: COLOR.accent })}</Text>
      if (block.level === 2) return title
      const width = widthOf(runs.map(run => run.text).join(''))

      return (
        <Box flexDirection="column">
          {title}
          <Text color={COLOR.accent}>{'━'.repeat(Math.max(1, Math.min(width, place.columns)))}</Text>
        </Box>
      )
    }

    case 'rule':
      return <Text color={COLOR.frame}>{'─'.repeat(Math.max(1, place.columns))}</Text>

    case 'code': {
      const key = `copy-${d.codes++}`
      const source = block.source

      // No frame round the code, so selecting it copies the code alone. The
      // button sits by the language, not across a wide terminal from it.
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Text color={COLOR.frame}>{block.lang || 'text'}</Text>
            <Button key={key} label="copy" dimColor onPress={() => d.copy(source, 'the code block')} />
          </Box>
          <Box paddingLeft={2}>
            <Code source={source} {...(block.lang ? { language: block.lang } : {})} />
          </Box>
        </Box>
      )
    }

    // Drawn as written, not read as markdown: what shows is what pastes.
    case 'copy': {
      const key = `copy-${d.codes++}`
      const { label, text } = block

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Text bold>{label || 'text'}</Text>
            <Button key={key} label="copy" dimColor onPress={() => d.copy(text, label ? `“${label}”` : 'the text')} />
          </Box>
          <Box flexDirection="row">
            <Box width={1} flexShrink={0} backgroundColor={COLOR.draft} />
            <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingLeft={1}>
              {text.split('\n').map(line => (
                <Text>{line || ' '}</Text>
              ))}
            </Box>
          </Box>
        </Box>
      )
    }

    case 'quote': {
      if (block.alert !== undefined) {
        const alert = ALERTS[block.alert]

        return (
          <Box flexDirection="column" alignSelf="flex-start" borderStyle="round" borderColor={alert.color} paddingX={1}>
            <Text bold color={alert.color}>
              {alert.label}
            </Text>
            {drawBlocks(d, block.blocks, { ...place, columns: place.columns - 4 })}
          </Box>
        )
      }

      return (
        <Box flexDirection="row">
          <Box width={1} flexShrink={0} backgroundColor={COLOR.bar} />
          <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingLeft={1}>
            {drawBlocks(d, block.blocks, { ...place, columns: place.columns - 2 })}
          </Box>
        </Box>
      )
    }

    case 'list': {
      const start = block.start
      const markers = block.items.map((item, n) =>
        item.task === 'done'
          ? '[✓]'
          : item.task === 'todo'
            ? '[ ]'
            : start !== undefined
              ? `${start + n}.`
              : BULLETS[place.depth % BULLETS.length]!,
      )
      const width = Math.max(...markers.map(widthOf)) + 1

      return (
        <Box flexDirection="column">
          {block.items.map((item, n) => {
            const inner: Place = {
              ...place,
              columns: place.columns - width,
              depth: place.depth + 1,
              ...(item.task === 'done' ? { dim: true, strike: true } : {}),
            }

            return (
              <Box flexDirection="row">
                <Box width={width} flexShrink={0}>
                  <Text color={item.task === 'done' ? COLOR.done : COLOR.accent}>{markers[n]}</Text>
                </Box>
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  {drawBlocks(d, item.blocks, inner, 0)}
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }

    case 'table':
      return drawTable(d, block, place)
  }
}

// A table boxed in rules, each column as wide as its widest line until the
// room runs out, then cut from the widest column first and wrapped. Rows
// get a rule between them only when one of them wraps.
function drawTable(d: Draw, table: Extract<Block, { kind: 'table' }>, place: Place): RenderElement {
  const { Box, Text } = d.el
  const cellRuns = (cell: string) => inline(cell.replace(/<br\s*\/?>/gi, '\n'))
  const head = table.head.map(cellRuns)
  const rows = table.rows.map(row => row.map(cellRuns))
  const count = head.length

  const natural = head.map((_, c) => Math.max(1, ...[head, ...rows].map(row => longestLine(row[c] ?? []))))
  const widths = shrink(natural, Math.max(count, place.columns - (3 * count + 1)))
  const headLines = head.map((cell, c) => wrap(cell, widths[c]!))
  const rowLines = rows.map(row => row.map((cell, c) => wrap(cell, widths[c]!)))
  const isWrapped = rowLines.some(row => row.some(cell => cell.length > 1))

  const rule = (left: string, middle: string, right: string) => (
    <Text color={COLOR.frame}>{left + widths.map(width => '─'.repeat(width + 2)).join(middle) + right}</Text>
  )
  const drawRow = (row: Run[][][], style: TextStyle) =>
    Array.from({ length: Math.max(1, ...row.map(cell => cell.length)) }, (_, line) => (
      <Text wrap="truncate-end">
        <Text color={COLOR.frame}>│</Text>
        {row.flatMap((cell, c) => {
          const runs = cell[line] ?? []
          const pad = widths[c]! - widthOf(runs.map(run => run.text).join(''))
          const align = table.align[c] ?? 'left'
          const before = align === 'right' ? pad : align === 'center' ? Math.floor(pad / 2) : 0

          return [
            ' '.repeat(before + 1),
            ...drawRuns(d, runs, place, style),
            ' '.repeat(pad - before + 1),
            <Text color={COLOR.frame}>│</Text>,
          ]
        })}
      </Text>
    ))

  return (
    <Box flexDirection="column">
      {rule('╭', '┬', '╮')}
      {drawRow(headLines, { bold: true, color: COLOR.accent })}
      {rule('├', '┼', '┤')}
      {rowLines.flatMap((row, n) => [
        ...(isWrapped && n > 0 ? [rule('├', '┼', '┤')] : []),
        ...drawRow(row, {}),
      ])}
      {rule('╰', '┴', '╯')}
    </Box>
  )
}

function longestLine(runs: Run[]): number {
  return Math.max(
    0,
    ...runs
      .map(run => run.text)
      .join('')
      .split('\n')
      .map(line => widthOf(line.replace(/ +/g, ' ').trim())),
  )
}

// Takes columns off the widest column, one at a time, until the widths fit.
function shrink(widths: number[], room: number): number[] {
  const out = [...widths]
  for (let excess = out.reduce((sum, width) => sum + width, 0) - room; excess > 0; excess--) {
    const widest = out.indexOf(Math.max(...out))
    if (out[widest]! <= 1) break
    out[widest]!--
  }

  return out
}

function drawRuns(d: Draw, runs: Run[], place: Place, style: TextStyle = {}): RenderElement[] {
  const { Link, Text } = d.el

  return runs.map(run => {
    const color = run.code
      ? COLOR.code
      : run.href !== undefined
        ? COLOR.link
        : run.number
          ? COLOR.number
          : run.path
            ? COLOR.path
            : style.color
    const props = {
      ...(color !== undefined ? { color } : {}),
      ...(run.bold || style.bold ? { bold: true } : {}),
      ...(run.italic ? { italic: true } : {}),
      ...(run.strike || place.strike ? { strikethrough: true } : {}),
      ...(place.dim ? { dimColor: true } : {}),
    }

    // A labelled web link is made clickable (a terminal without links shows
    // its address after it); a bare address is left for the terminal to
    // find, as a link would print it twice there. Any other target is shown
    // beside its text, so a click never opens something the text hides.
    if (run.href !== undefined && run.href !== run.text && /^https?:\/\//i.test(run.href)) {
      return (
        <Text {...props}>
          <Link href={run.href}>{run.text}</Link>
        </Text>
      )
    }
    const text = run.href !== undefined && run.href !== run.text ? `${run.text} (${run.href})` : run.text

    return <Text {...props}>{text}</Text>
  })
}
