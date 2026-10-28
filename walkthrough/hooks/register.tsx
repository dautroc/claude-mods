import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cursor, Diagram, Review, Shown } from '../types'
import { type Actions, drawItem, drawSummary } from './draw'
import { type Colors, colorsOf, parseRendered } from './preview'
import {
  MAX_CHOICES,
  MAX_ITEMS,
  answersMessage,
  defaultChoice,
  goTo,
  isAnswered,
  isSummary,
  mark,
  nextUnanswered,
  openedText,
  parseReview,
  ringKeys,
  setNote,
  stepRing,
  submit,
} from './review'

type Engine = EngineInterface
type Answer = { result: string } | { deny: string }

const PANE = 'walkthrough'
const TOOL = 'mcp__walkthrough__review_items'
// What `Image` takes from bytes.
const MAX_PNG_BYTES = 2 * 1024 * 1024
// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const review = atom({ plugin: 'walkthrough', key: 'review' } as const, null, { shape: 'review-1' })
const diagrams = atom({ plugin: 'walkthrough', key: 'diagrams' } as const, { review: '', byItem: {} }, { shape: 'diagrams-1' })
const shown = atom({ plugin: 'walkthrough', key: 'shown' } as const, 'picture' as Shown)
const cursor = atom({ plugin: 'walkthrough', key: 'cursor' } as const, null, { shape: 'cursor-1' })
// How many notes Enter has saved, which keys the Note field: the terminal
// empties a field on Enter and puts back the text it is drawn with only when
// that differs from the last, so each save draws a field afresh.
const saved = atom({ plugin: 'walkthrough', key: 'saved' } as const, 0)
// Docked as wide as it may be; inline above the prompt, as tall.
const OPEN = { id: PANE, title: 'Review', focus: true, columns: 96, rows: 40 } as const

// What the terminal last said of the pane's keyboard: whether the pane held
// the keys, when it last lost them, and the element its ring is on. A key the
// pane doesn't take (Space, a letter that is no hotkey) leaves it for the
// prompt box as an edit, and these tell that edit apart from typing there.
let hadKeys = false
let lostKeysAt = 0
let ring: string | undefined
// How soon after the pane lost the keys an edit still counts as typed in it.
const STRAY_MS = 200

function noteKey(saves: number): string {
  return `note-${saves}`
}

function argsOf(e: object): Record<string, unknown> {
  return e as Record<string, unknown>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// The colours of the person's theme, for the pictures: a custom theme's are
// in its file under ~/.claude/themes.
async function themeColors($: Engine): Promise<Colors> {
  try {
    const theme = String((await $.config.list()).find(row => row.key === 'theme')?.value ?? '')
    if (!theme.startsWith('custom:')) {
      return colorsOf(theme)
    }

    const home = await $.env.get('HOME')
    const file = await $.fs.read(`${home}/.claude/themes/${theme.slice('custom:'.length)}.json`)

    return colorsOf(theme, JSON.parse(file))
  } catch {
    return colorsOf('dark')
  }
}

// Whether the terminal likely draws an `Image` as pixels rather than its alt.
// Claude Code asks the terminal (kitty, Ghostty, iTerm2), which a mod can't,
// so this guesses from the environment; t switches either way.
async function drawsImages($: Engine): Promise<boolean> {
  const [force, program, kitty] = await Promise.all([
    $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'),
    $.env.get('TERM_PROGRAM'),
    $.env.get('KITTY_WINDOW_ID'),
  ])

  return force === '1' || kitty !== undefined || program === 'ghostty' || program === 'iTerm.app'
}

// Draws the review's Mermaid diagrams with render/mermaid.mjs under node: the
// text versions, and a PNG each where rsvg-convert is installed.
async function drawDiagrams($: Engine, fresh: Review): Promise<Record<string, Diagram>> {
  const wanted = fresh.items.flatMap((item, at) =>
    item.preview?.kind === 'mermaid' ? [{ key: String(at), source: item.preview.source }] : [],
  )
  if (wanted.length === 0) {
    return {}
  }

  const failed = (why: string) => Object.fromEntries(wanted.map(({ key }) => [key, { error: why }]))
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  const out = `${tmp}/claude-walkthrough/${(await $.session.id()).slice(0, 8)}/${fresh.id}`
  const request = { out, colors: await themeColors($), diagrams: wanted }
  const ran = await $.process
    .run(['node', `${$.plugin.root}/render/mermaid.mjs`], { stdin: JSON.stringify(request), timeoutMs: 60_000 })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: `node could not run: ${messageOf(error)}` }))
  if (ran.exitCode !== 0) {
    return failed(ran.stderr.trim().split('\n')[0] || `the renderer exited with ${ran.exitCode}`)
  }

  let found: Map<string, Diagram>
  try {
    found = parseRendered(ran.stdout)
  } catch {
    return failed('the renderer sent back no answer')
  }

  const byItem: Record<string, Diagram> = {}
  for (const { key } of wanted) {
    const diagram = found.get(key) ?? { error: 'the renderer left it out' }
    if (diagram.file !== undefined) {
      const bytes = await $.fs.read(diagram.file, { as: 'bytes' }).catch(() => undefined)
      if (bytes !== undefined && (bytes.base64.length * 3) / 4 <= MAX_PNG_BYTES) {
        diagram.png = bytes.base64
      }
    }
    byItem[key] = diagram
  }

  return byItem
}

// Opens the pane with the keyboard, and says where it went when it couldn't
// take it.
async function openPane($: Engine): Promise<boolean> {
  const opened = await $.ui.open(OPEN)
  if (!opened.isPlaced) {
    $.ui.toast('Claude has items for you to review: /walk opens them.')

    return false
  }

  const pane = (await $.ui.panes()).find(each => each.id === PANE)
  if (pane !== undefined && !pane.isFocused) {
    $.ui.toast('Claude has items for you to review: ctrl+x tab answers them.')
  }

  return true
}

async function openReview($: Engine, input: Record<string, unknown>, call: string): Promise<Answer> {
  let fresh: Review
  try {
    fresh = { ...parseReview(input, crypto.randomUUID().slice(0, 8)), call }
  } catch (error) {
    return { deny: messageOf(error) }
  }

  const byItem = await drawDiagrams($, fresh)
  const earlier = await read($, review)
  const first: Shown = (await drawsImages($)) ? 'picture' : 'text'
  await update($, diagrams, () => ({ review: fresh.id, byItem }))
  await update($, shown, () => first)
  await update($, review, () => fresh)
  const isPlaced = await openPane($)
  const undrawn = Object.entries(byItem).flatMap(([at, diagram]) =>
    diagram.error === undefined ? [] : [{ at: Number(at), why: diagram.error }],
  )

  return {
    result: openedText(fresh, { isPlaced, undrawn, ...(earlier === null ? {} : { replaced: earlier.title }) }),
  }
}

// Changes the review in the pane, unless another has taken its place.
function change($: Engine, id: string, fn: (current: Review) => Review) {
  return update($, review, current => (current === null || current.id !== id ? current : fn(current)))
}

// Sends the answers as the person's next message, on a timer, as the submit
// waits for the turn it starts. Should it be refused, the review comes back.
async function send($: Engine) {
  const sent = await read($, review)
  if (sent === null) {
    return
  }

  await update($, review, () => null)
  await $.ui.close({ id: PANE }).catch(() => undefined)
  hadKeys = false
  ring = undefined
  $.clock.after(1, () => void deliver($, sent))
}

async function deliver($: Engine, sent: Review) {
  const why = await $.prompt.submit({ text: answersMessage(sent), asUser: true }).then(
    submitted => submitted.drop,
    (error: unknown) => messageOf(error),
  )
  if (why === undefined) {
    return
  }

  await update($, review, current => current ?? sent)
  $.ui.toast(`Couldn't send your answers (${why}). /walk opens the review again.`)
}

// The choice the ring starts on in the item shown: the last one it was on
// there, else the one picked or recommended.
function cursorOf(current: Review, last: Cursor | null): number {
  return last !== null && last.review === current.id && last.at === current.at ? last.choice : defaultChoice(current)
}

// Where the ring starts in what the pane shows, as the drawing's autoFocus
// says: the cursor's choice, `l` on an item without choices, Send.
function startKey(current: Review, last: Cursor | null): string {
  if (isSummary(current)) {
    return 'send'
  }

  return current.items[current.at]!.choices.length > 0 ? `choice-${cursorOf(current, last)}` : 'key-l'
}

// The ring is on `key` now: keep it, and on a choice, the cursor too.
async function noteRing($: Engine, current: Review, key: string | undefined) {
  ring = key
  if (key?.startsWith('choice-') && !isSummary(current)) {
    const choice = Number(key.slice('choice-'.length))
    await update($, cursor, () => ({ review: current.id, at: current.at, choice }))
  }
}

async function focusOn($: Engine, current: Review, key: string) {
  const moved = await $.ui.focus({ requestId: PANE, key }).catch(() => ({ deny: 'not focused' }))
  if (moved.deny === undefined) {
    await noteRing($, current, key)
  }
}

// The pane moved to another item or the summary: the ring goes where it
// starts there.
async function focusStart($: Engine, id: string) {
  const current = await read($, review)
  if (current !== null && current.id === id) {
    await focusOn($, current, startKey(current, await read($, cursor)))
  }
}

// j (`by` 1) and k (-1): the ring down or up the choices, or the summary's
// items and Send.
async function moveRing($: Engine, id: string, by: number) {
  const current = await read($, review)
  if (current === null || current.id !== id) {
    return
  }

  const keys = ringKeys(current)
  if (keys.length > 0) {
    await focusOn($, current, stepRing(keys, ring, startKey(current, await read($, cursor)), by))
  }
}

// Enter in the field saves the note. On an item with choices the ring goes
// back to them; without, the note is the answer and the pane moves on, past
// the item as skipped while it is empty.
async function submitNote($: Engine, id: string, value: string) {
  await update($, saved, n => n + 1)
  await change($, id, r => {
    const noted = setNote(r, value)
    if (isSummary(noted) || noted.items[noted.at]!.choices.length > 0) {
      return noted
    }

    return goTo(noted, isAnswered(noted.answers[noted.at]) ? nextUnanswered(noted, noted.at) : noted.at + 1)
  })
  await focusStart($, id)
}

// Gives the pane the keys back, the ring starting where it starts; refused
// while the prompt box holds a draft.
async function takeKeys($: Engine) {
  await $.ui.open(OPEN).catch(() => undefined)
}

// The terminal drew the pane: whether it holds the keys. Losing them with the
// ring in the Note field is Esc there, which clears the note and gives the
// keys back to the choices.
async function trackKeys($: Engine, isFocused: boolean) {
  if (hadKeys && !isFocused) {
    lostKeysAt = await $.clock.now()
    if (ring?.startsWith('note-')) {
      ring = undefined
      $.clock.after(1, () => void clearNote($))
    }
  }
  hadKeys = isFocused
}

async function clearNote($: Engine) {
  const current = await read($, review)
  if (current !== null && !isSummary(current)) {
    await change($, current.id, r => setNote(r, ''))
    await takeKeys($)
  }
}

// Whether an edit of the empty prompt box is a key typed in the pane: one
// that came while the pane held the keys, or as it lost them.
async function isStray($: Engine): Promise<boolean> {
  if (!hadKeys && (await $.clock.now()) - lostKeysAt > STRAY_MS) {
    return false
  }
  if ((await read($, review)) === null) {
    return false
  }

  const pane = (await $.ui.panes()).find(each => each.id === PANE)

  return pane?.isShown === true && pane.isPlaced
}

// Space in the pane: the choice under the ring marked.
async function markRing($: Engine) {
  const current = await read($, review)
  if (current !== null && !isSummary(current) && ring?.startsWith('choice-')) {
    const choice = Number(ring.slice('choice-'.length))
    await change($, current.id, r => mark(r, choice))
  }
}

function actionsFor($: Engine, current: Review, note: string): Actions {
  const { id } = current

  return {
    submit: choice => void change($, id, r => submit(r, choice)).then(() => focusStart($, id)),
    move: by => void moveRing($, id, by),
    go: at => void change($, id, r => goTo(r, at)).then(() => focusStart($, id)),
    note: value => void change($, id, r => setNote(r, value)),
    submitNote: value => void submitNote($, id, value),
    write: () =>
      void $.ui
        .focus({ requestId: PANE, key: note })
        .then(moved => {
          if (moved.deny === undefined) {
            ring = note
          }
        })
        .catch(() => undefined),
    cycle: modes =>
      void update($, shown, mode => {
        const now = modes.indexOf(mode)

        return modes[(now + 1) % modes.length] ?? 'picture'
      }),
    view: file =>
      void $.process
        .run(['/usr/bin/open', file])
        .catch((error: unknown) => $.ui.toast(`Couldn't open the picture: ${messageOf(error)}`)),
    send: () => void send($),
  }
}

const CHOICE = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'The choice in a few words.' },
    detail: { type: 'string', description: 'Optional: what it means or costs, in one line.' },
    recommended: { type: 'boolean', description: 'True on the choice you recommend.' },
  },
  required: ['label'],
  additionalProperties: false,
}
const PREVIEW = {
  type: 'object',
  description:
    'Optional: what helps to see beside the item. mermaid: a Mermaid diagram (flowchart, sequence, state, class or ER; pie, gantt and mindmap show as source); markdown: a table or other Markdown; code: code in `language`; diff: a unified diff.',
  properties: {
    kind: { type: 'string', enum: ['mermaid', 'markdown', 'code', 'diff'] },
    source: { type: 'string' },
    language: { type: 'string', description: 'For code or diff: the language, such as "ts".' },
  },
  required: ['kind', 'source'],
  additionalProperties: false,
}

// Added to the system prompt beside the tool's description, so the model
// reaches for the tool where it would otherwise write the list out.
const RULE = `# Items for the person to decide

When a reply would hand the person two or more items that each need a decision or an action from them (design questions, review findings to accept or reject, steps for them to confirm), don't write the items out: call ${TOOL} with them, then end your turn with one short line. The person answers them one at a time in a pane beside the chat, and their answers come back as their next message. One question, or one to four quick ones in the middle of a task, still goes to AskUserQuestion.`

export const register: Register = on => {
  // The tool is for a person at the prompt: under -p or the SDK nobody could
  // answer, and nothing draws the pane.
  on('session.start', async ($, e, next) => {
    if (!e.isInteractive) {
      return next(e)
    }

    await $.tool.register({
      name: 'review_items',
      description: [
        'Shows the person a list of items that each need a decision or an action from them in a pane beside the chat, one item at a time with your recommendation and the choices, and sends their answers back as their next message.',
        'Use it instead of writing the items out in your reply whenever a reply would hand the person two or more such items: design questions, review findings to accept or reject, steps for them to confirm.',
        "Give each item the context they need to decide in `body`, short; what you recommend and why in `recommendation`; and 2-4 choices with the one you recommend first and marked `recommended`, or no choices when the answer is the person's own words. Add a `preview` where seeing helps: a Mermaid diagram, a Markdown table, code or a diff.",
        "After the call, end your turn with one short line, without repeating the items. For one to four quick questions in the middle of a task, AskUserQuestion is still the tool.",
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What the review is about, in a few words: "Release plan".' },
          items: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_ITEMS,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'The item in a few words.' },
                body: { type: 'string', description: 'Markdown: the context the person needs to decide, short.' },
                recommendation: { type: 'string', description: 'What you recommend and why, in a sentence or two.' },
                choices: { type: 'array', maxItems: MAX_CHOICES, items: CHOICE },
                multiSelect: { type: 'boolean', description: 'True when several choices may be picked together.' },
                preview: PREVIEW,
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'items'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'walk',
      description: 'Open the review pane: the items Claude handed you to decide, one at a time',
      immediate: true,
    })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL) || e.surfaces.length === 0 || e.traits.includes('print') || e.traits.includes('bare')) {
      return composed
    }

    return { sections: [...composed.sections, { id: 'walkthrough:review', text: RULE, scope: 'session' }] }
  })

  on('tool.call', { tool: TOOL }, ($, e) => openReview($, argsOf(e), e.tool_use_id)).catch(() => ({
    deny: 'The review could not be opened.',
  }))

  on('command.run', { command: 'walk' }, async $ => {
    if ((await read($, review)) === null) {
      $.ui.toast('No review is open. Claude opens one when it has items for you to decide.')
    } else {
      await openPane($)
    }

    return {}
  }).catch($ => {
    $.ui.toast("Couldn't open the review.")

    return {}
  })

  // A /clear ends the conversation the review was for.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, review, () => null)
      await update($, diagrams, () => ({ review: '', byItem: {} }))
      await $.ui.close({ id: PANE }).catch(() => undefined)
      hadKeys = false
      ring = undefined
    }

    return next(e)
  })

  // The person's Tab, arrows or click, or an autoFocus as the pane takes the
  // keys, moved the ring. The mod's own $.ui.focus moves don't come here.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (moved.deny === undefined) {
      const current = await read($, review)
      if (current === null) {
        ring = e.element
      } else {
        await noteRing($, current, e.element)
      }
    }

    return moved
  })

  // A key the pane doesn't take lands in the empty prompt box and takes the
  // keys there. It is kept out of the box, the keys go back to the pane, and
  // Space marks the choice under the ring.
  on('prompt.edit', async ($, e, next) => {
    if (e.key === undefined || e.text !== '' || !(await isStray($))) {
      return next(e)
    }
    if (e.key.key === 'space') {
      await markRing($)
    }
    $.clock.after(1, () => void takeKeys($))

    return { text: e.text, cursor: e.cursor }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'terminal') {
      await trackKeys($, e.props.isFocused)
    }

    const current = await read($, review)
    const el = $.ui.resolve(e)
    if (current === null) {
      return <el.Text dimColor>No review is open. Claude opens one here when it has items for you to decide.</el.Text>
    }

    const drawn = await read($, diagrams)
    const mode = await read($, shown)
    const note = noteKey(await read($, saved))
    const d = {
      el,
      surface: e.surface,
      act: actionsFor($, current, note),
      columns: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
    }
    if (isSummary(current)) {
      return drawSummary(d, current)
    }

    const diagram = drawn.review === current.id ? drawn.byItem[String(current.at)] : undefined

    return drawItem(d, current, diagram, mode, cursorOf(current, await read($, cursor)), note)
  })

  // The call's row lists the items' titles, with a button that opens the pane
  // while this review is the open one. ctrl+o shows the call as it was sent.
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e, next) => {
    if (e.props.isExpanded === true) {
      return next(e)
    }

    let asked: Review
    try {
      asked = parseReview(e.props.input as Record<string, unknown>, '')
    } catch {
      return next(e)
    }

    const current = await read($, review)
    const { Box, Button, Text } = $.ui.resolve(e)
    const bullet = e.props.isErrored
      ? { color: 'error' as const }
      : e.props.isRunning
        ? { dimColor: true }
        : { color: 'success' as const }
    const n = asked.items.length

    return (
      <Box flexDirection="column" marginTop={1}>
        <Box columnGap={1}>
          <Text {...bullet}>⏺</Text>
          <Text bold>Review</Text>
          <Text>{asked.title}</Text>
          <Text dimColor>{`· ${n} item${n === 1 ? '' : 's'}`}</Text>
          {current?.call === e.props.tool_use_id && (
            <Button key="open" label="open" dimColor onPress={() => void openPane($)} />
          )}
        </Box>
        <Box flexDirection="column">
          {asked.items.map((item, k) => (
            <Text dimColor wrap="truncate-end">{`${k === 0 ? '  ⎿  ' : '     '}${k + 1}. ${item.title}`}</Text>
          ))}
        </Box>
      </Box>
    )
  })

  // The result is what Claude was told to do next; the person has the pane.
  on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, ($, e, next) => {
    if (e.props.isErrored) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box />
  })
}
