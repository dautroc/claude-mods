import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { COPY_RULE } from './copy'
import { type Draw, copyOf, drawBlocks } from './draw'
import { type Row, hint } from './flash'
import { type Block, type Breaks, type Copyable, copyables, inline, parse } from './markdown'

// The columns a transcript row has when the terminal hasn't measured it.
const COLUMNS = 80

// The terminal redraws a message on every resize and, in fullscreen, as it
// scrolls past the edge, so the newest texts keep what they parse to.
const parsed = new Map<string, Block[]>()

function parseOnce(text: string, breaks: Breaks): Block[] {
  const key = `${breaks}:${text}`
  const cached = parsed.get(key)
  if (cached !== undefined) return cached

  const blocks = parse(text, breaks)
  parsed.set(key, blocks)
  if (parsed.size > 64) parsed.delete(parsed.keys().next().value!)

  return blocks
}

// Whether a command's output is markdown at all: more than paragraphs, or
// paragraphs with code, emphasis or a link. Anything else, such as a
// command's lines laid out by hand, is left to the engine.
function isMarkdown(blocks: Block[]): boolean {
  return blocks.some(
    block =>
      block.kind !== 'paragraph' ||
      inline(block.text).some(run => run.code || run.bold || run.italic || run.strike || run.href !== undefined),
  )
}

// /flash-copy's letters, by reply row: what the rows on screen draw before
// their copy buttons; empty while no hints are up.
const hints = atom({ plugin: 'reply-style', key: 'hints' } as const, {}, { shape: 'hints-1' })

async function copy($: EngineInterface, text: string, what: string): Promise<void> {
  const copied = await $.ui.copy({ text, surface: 'terminal' })
  $.ui.toast(copied.isCopied ? `Copied ${what}.` : `Couldn't copy ${what} (${copied.reason}).`)
}

export const register: Register = on => {
  // The reply rows on screen with a copy button, by requestId, and when each
  // was first drawn, which orders them as the transcript does.
  const rows = new Map<string, Row>()
  const drawnAt = new Map<string, number>()
  // While hints are up, the block each letter copies.
  let targets = new Map<string, Copyable>()

  // Replies on the terminal only: the apps draw markdown as rich text of
  // their own. A summary of the model's text keeps the engine's row, which
  // marks it as one.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary) return next(e)
    const blocks = parseOnce(e.props.text, 'space')
    if (blocks.length === 0) return next(e)

    // `onScreen` is null while the row is scrolled out of the viewport.
    const buttons = copyables(blocks)
    if (e.props.onScreen === null || buttons.length === 0) rows.delete(e.requestId)
    else {
      if (!drawnAt.has(e.requestId)) drawnAt.set(e.requestId, drawnAt.size)
      rows.set(e.requestId, { order: drawnAt.get(e.requestId)!, blocks: buttons })
    }

    const el = $.ui.resolve(e)
    const { Box, Text } = el
    const d: Draw = {
      el,
      codes: 0,
      hints: (await read($, hints))[e.requestId] ?? [],
      copy: block => void copy($, copyOf(block).text, copyOf(block).what),
    }
    const columns = (e.viewport?.columns ?? COLUMNS) - 2

    return (
      <Box flexDirection="row" marginTop={1}>
        <Box width={2} flexShrink={0}>
          <Text color="text">{e.props.isFirstOfReply ? '⏺' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {drawBlocks(d, blocks, { columns, depth: 0 })}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'CommandOutput' }, ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored || e.props.text.includes('\u001b')) return next(e)
    const blocks = parseOnce(e.props.text, 'line')
    if (!isMarkdown(blocks)) return next(e)

    const el = $.ui.resolve(e)
    const { Box, Text } = el
    const d: Draw = { el, codes: 0, hints: [], copy: block => void copy($, copyOf(block).text, copyOf(block).what) }
    const columns = (e.viewport?.columns ?? COLUMNS) - 5

    return (
      <Box flexDirection="row">
        <Box width={5} flexShrink={0}>
          <Text dimColor>{'  ⎿  '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {drawBlocks(d, blocks, { columns, depth: 0 })}
        </Box>
      </Box>
    )
  })

  // Teaches the model to put text the person pastes elsewhere in a `copy`
  // block. Not under -p, where nothing draws and a script reads the reply.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.surfaces.length === 0 || e.traits.includes('print') || e.traits.includes('bare')) return composed

    return { sections: [...composed.sections, { id: 'reply-style:copy', text: COPY_RULE, scope: 'session' }] }
  })

  on('session.start', async ($, e, next) => {
    rows.clear()
    drawnAt.clear()
    targets = new Map()
    await update($, hints, () => ({}))
    await $.command.register({
      name: 'reply-style',
      description: "Copy Claude's last reply, or the last code block or draft in it",
      argumentHint: 'copy [code|draft]',
      immediate: true,
    })
    await $.command.register({
      name: 'flash-copy',
      description: 'Show a letter on each code block and draft on screen; type one to copy it',
      immediate: true,
    })

    return next(e)
  })

  // Puts a letter before each copy button on screen, or takes them down when
  // they are up. Meant for a key: `ctrl+x y` as `command:flash-copy`.
  on('command.run', { command: 'flash-copy' }, async ($, e) => {
    if (targets.size > 0) {
      targets = new Map()
      await update($, hints, () => ({}))

      return {}
    }
    // Outside fullscreen the rows above the prompt are never drawn again.
    if (!e.presentation.isFullscreen) {
      $.ui.toast('Copy hints need the fullscreen layout. /reply-style copy [code|draft] works in any.')

      return {}
    }

    const shown = hint(rows)
    if (shown.targets.size === 0) {
      $.ui.toast('No code block or draft on screen to copy.')

      return {}
    }
    targets = shown.targets
    await update($, hints, () => shown.letters)

    return {}
  })

  // While hints are up, the next key is theirs: a hint's letter copies its
  // block and is kept out of the box; any other key takes the hints down and
  // lands as typed.
  on('prompt.edit', async ($, e, next) => {
    if (targets.size === 0) return next(e)
    const target = e.start === e.end ? targets.get(e.inputText) : undefined
    targets = new Map()
    await update($, hints, () => ({}))
    if (target === undefined) return next(e)

    const { text, what } = copyOf(target)
    await copy($, text, what)

    return { text: e.text, cursor: e.cursor }
  })

  on('prompt.submit', async ($, e, next) => {
    if (targets.size > 0) {
      targets = new Map()
      await update($, hints, () => ({}))
    }

    return next(e)
  })

  // Answered with a toast and no output row, which the model would read.
  on('command.run', { command: 'reply-style' }, async ($, e) => {
    const [verb, what, ...rest] = e.args.trim().split(/\s+/)
    if (verb !== 'copy' || (what !== undefined && what !== 'code' && what !== 'draft') || rest.length > 0) {
      $.ui.toast('Usage: /reply-style copy [code|draft]')

      return {}
    }

    const reply = (await $.session.messages()).findLast(m => m.role === 'assistant' && m.text.trim() !== '')
    if (reply === undefined) {
      $.ui.toast('There is no reply to copy yet.')

      return {}
    }
    if (what === undefined) {
      await copy($, reply.text, 'the last reply')

      return {}
    }

    const buttons = copyables(parse(reply.text))
    if (what === 'draft') {
      const draft = buttons.findLast(block => block.kind === 'copy')
      if (draft === undefined) $.ui.toast('The last reply has no draft.')
      else await copy($, draft.text, draft.label ? `“${draft.label}”` : 'the last draft')

      return {}
    }

    const code = buttons.findLast(block => block.kind === 'code')
    if (code === undefined) $.ui.toast('The last reply has no code block.')
    else await copy($, code.source, 'the last code block')

    return {}
  })
}
