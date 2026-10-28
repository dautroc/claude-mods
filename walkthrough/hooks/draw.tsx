import type { Color, ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { Diagram, Item, Review, Shown } from '../types'
import { diagramText, pictureBox } from './preview'
import { answerText, answeredCount, isAnswered } from './review'
import { fitTables } from './tables'

// Theme keys, so the pane follows the person's /theme.
const COLOR = {
  title: 'claude',
  done: 'success',
  star: 'success',
  frame: 'inactive',
  open: 'warning',
} as const satisfies Record<string, Color>

// What the pane's controls do, bound to the session by the hooks module.
export type Actions = {
  submit: (choice: number) => void
  move: (by: number) => void
  go: (at: number) => void
  note: (value: string) => void
  submitNote: (value: string) => void
  write: () => void
  cycle: (modes: readonly Shown[]) => void
  view: (file: string) => void
  send: () => void
}

export type Draw = {
  el: ElementTable
  surface: RenderSurface
  act: Actions
  // The pane's body: its columns, and the rows its window shows.
  columns: number
  rows: number
}

// The review's title, where the pane is, and a dot per item: filled once
// answered, the shown one marked.
function drawHeader(d: Draw, review: Review, where: string): RenderElement {
  const { Box, Text } = d.el

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" columnGap={2}>
        <Text bold>{review.title}</Text>
        <Text dimColor>{where}</Text>
      </Box>
      <Box>
        {review.items.map((_, k) => {
          const glyph = k === review.at ? '◉' : isAnswered(review.answers[k]) ? '●' : '○'

          return isAnswered(review.answers[k]) ? (
            <Text color={COLOR.done}>{glyph}</Text>
          ) : (
            <Text dimColor={k !== review.at}>{glyph}</Text>
          )
        })}
      </Box>
    </Box>
  )
}

// The ways a diagram can be shown here: the picture where the surface draws
// one (the terminal alone) and it was made, the text version where there is
// one, the source.
export function modesOf(d: Pick<Draw, 'el' | 'surface'>, diagram: Diagram | undefined): Shown[] {
  return [
    ...(d.surface === 'terminal' && 'Image' in d.el && diagram?.png !== undefined ? (['picture'] as const) : []),
    ...(diagram?.text !== undefined ? (['text'] as const) : []),
    'source',
  ]
}

function drawLines(d: Draw, text: string): RenderElement {
  const { Box, Text } = d.el

  return (
    <Box flexDirection="column">
      {text.split('\n').map(line => (
        <Text wrap="truncate-end">{line === '' ? ' ' : line}</Text>
      ))}
    </Box>
  )
}

function drawDiagram(d: Draw, item: Item, diagram: Diagram | undefined, shown: Shown, columns: number): RenderElement {
  const { Code, Text, Box } = d.el
  const source = item.preview!.source
  const modes = modesOf(d, diagram)
  const mode = modes.includes(shown) ? shown : modes[0]!

  if (mode === 'picture' && d.surface === 'terminal' && 'Image' in d.el && diagram?.png !== undefined) {
    const box = pictureBox(diagram.width!, diagram.height!, columns, Math.max(8, Math.floor(d.rows * 0.45)))

    return (
      <d.el.Image
        key="diagram"
        source={{ png: diagram.png }}
        columns={box.columns}
        rows={box.rows}
        alt="Diagram (t shows it as text)"
      />
    )
  }
  if (mode === 'text' && diagram !== undefined) {
    const text = diagramText(diagram, columns)
    if (text !== undefined) {
      return drawLines(d, text)
    }
  }

  return (
    <Box flexDirection="column">
      {diagram?.error !== undefined && <Text color="error">{`Couldn't draw the diagram: ${diagram.error}`}</Text>}
      <Code source={source} language="mermaid" wrap="truncate-end" />
    </Box>
  )
}

function drawPreview(d: Draw, item: Item, diagram: Diagram | undefined, shown: Shown): RenderElement | null {
  const preview = item.preview
  if (preview === undefined) {
    return null
  }

  const { Box, Code, Markdown } = d.el
  // Inside the frame: its two sides and a space either side.
  const columns = Math.max(10, d.columns - 4)
  const body =
    preview.kind === 'mermaid' ? (
      drawDiagram(d, item, diagram, shown, columns)
    ) : preview.kind === 'markdown' ? (
      <Markdown text={fitTables(preview.source, columns)} />
    ) : preview.kind === 'diff' ? (
      <Code source={preview.source} format="diff" {...(preview.language ? { language: preview.language } : {})} />
    ) : (
      <Code source={preview.source} {...(preview.language ? { language: preview.language } : {})} />
    )

  return (
    <Box borderStyle="round" borderColor={COLOR.frame} paddingX={1} flexDirection="column">
      {body}
    </Box>
  )
}

// The choices, the ring starting on `cursor`. Enter (or on a single-choice
// item its digit) submits the one under the ring; Space, which the hooks
// module catches, marks it.
function drawChoices(d: Draw, item: Item, picked: readonly number[], cursor: number): RenderElement | null {
  if (item.choices.length === 0) {
    return null
  }

  const { Box, Button, Text } = d.el
  const multi = item.multiSelect === true

  return (
    <Box flexDirection="column">
      {item.choices.map((choice, k) => {
        const isPicked = picked.includes(k)
        const mark = multi ? (isPicked ? '[x] ' : '[ ] ') : isPicked ? '● ' : '○ '

        return (
          <Box flexDirection="column">
            <Button
              key={`choice-${k}`}
              plain
              onPress={() => d.act.submit(k)}
              {...(multi ? {} : { hotkey: String(k + 1) })}
              {...(k === cursor ? { autoFocus: true as const } : {})}
            >
              {isPicked ? <Text color={COLOR.done}>{mark}</Text> : mark}
              {choice.label}
              {choice.recommended === true ? <Text color={COLOR.star}> ★</Text> : ''}
            </Button>
            {choice.detail !== undefined && (
              <Box paddingLeft={5}>
                <Text dimColor>{choice.detail}</Text>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

function key(d: Draw, hotkey: string, label: string, onPress: () => void, autoFocus = false): RenderElement {
  const { Button } = d.el

  return (
    <Button
      key={`key-${hotkey}`}
      plain
      dimColor
      hotkey={hotkey}
      label={label}
      onPress={onPress}
      {...(autoFocus ? { autoFocus: true as const } : {})}
    />
  )
}

// One item: its title and body, the preview, the recommendation, the choices
// with the ring starting on `cursor`, the Note field keyed `note` and the keys.
export function drawItem(
  d: Draw,
  review: Review,
  diagram: Diagram | undefined,
  shown: Shown,
  cursor: number,
  note: string,
): RenderElement {
  const { Box, Markdown, Text } = d.el
  const item = review.items[review.at]!
  const answer = review.answers[review.at]!
  const modes = item.preview?.kind === 'mermaid' ? modesOf(d, diagram) : []
  const picture = item.preview?.kind === 'mermaid' && modes.includes('picture') ? diagram?.file : undefined
  const n = review.items.length

  return (
    <Box flexDirection="column" gap={1}>
      {drawHeader(d, review, `${review.at + 1} / ${n}`)}
      <Box flexDirection="column">
        <Text bold color={COLOR.title}>
          {item.title}
        </Text>
        {item.body !== undefined && <Markdown text={fitTables(item.body, d.columns)} />}
      </Box>
      {drawPreview(d, item, diagram, shown)}
      {item.recommendation !== undefined && (
        <Text>
          <Text color={COLOR.star}>★ Recommended: </Text>
          {item.recommendation}
        </Text>
      )}
      {drawChoices(d, item, answer.picked, cursor)}
      {d.surface !== 'mobile' && 'Input' in d.el && (
        <d.el.Input
          key={note}
          value={answer.note}
          placeholder={item.choices.length === 0 ? 'Your answer' : 'A note, or your own answer'}
          submitLabel={item.choices.length === 0 ? 'next' : 'save'}
          onInput={value => d.act.note(value)}
          onSubmit={value => d.act.submitNote(value)}
        />
      )}
      <Box columnGap={2} flexWrap="wrap">
        {item.choices.length > 0 ? key(d, 'j', 'down', () => d.act.move(1)) : null}
        {item.choices.length > 0 ? key(d, 'k', 'up', () => d.act.move(-1)) : null}
        {review.at > 0 ? key(d, 'h', 'back', () => d.act.go(review.at - 1)) : null}
        {key(d, 'l', review.at + 1 < n ? 'next' : 'summary', () => d.act.go(review.at + 1), item.choices.length === 0)}
        {d.surface !== 'mobile' ? key(d, 'w', 'write', d.act.write) : null}
        {modes.length > 1 ? key(d, 't', 'picture/text', () => d.act.cycle(modes)) : null}
        {picture !== undefined ? key(d, 'v', 'view large', () => d.act.view(picture)) : null}
        {key(d, 's', 'send…', () => d.act.go(n))}
      </Box>
    </Box>
  )
}

// Every item with its answer, a digit jumping back to one, and Send.
export function drawSummary(d: Draw, review: Review): RenderElement {
  const { Box, Button, Text } = d.el
  const n = review.items.length
  const answered = answeredCount(review)

  return (
    <Box flexDirection="column" gap={1}>
      {drawHeader(d, review, `${answered} of ${n} answered`)}
      <Box flexDirection="column">
        {review.items.map((item, k) => {
          const answer = review.answers[k]!

          return (
            <Button key={`item-${k}`} plain onPress={() => d.act.go(k)} {...(k < 9 ? { hotkey: String(k + 1) } : {})}>
              {`${item.title} `}
              {isAnswered(answer) ? (
                <Text dimColor>{`· ${answerText(item, answer)}`}</Text>
              ) : (
                <Text color={COLOR.open}>· skipped</Text>
              )}
            </Button>
          )
        })}
      </Box>
      <Box columnGap={2} flexWrap="wrap">
        <Button key="send" label="Send answers" variant="primary" hotkey="s" autoFocus onPress={d.act.send} />
        {key(d, 'j', 'down', () => d.act.move(1))}
        {key(d, 'k', 'up', () => d.act.move(-1))}
        {key(d, 'h', 'back', () => d.act.go(n - 1))}
      </Box>
      {answered < n && <Text dimColor>Unanswered items are sent as skipped.</Text>}
    </Box>
  )
}
