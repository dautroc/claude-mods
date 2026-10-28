import type { EngineInterface, Register } from 'claude-code'

import { COPY_RULE } from './copy'
import { type Draw, drawBlocks } from './draw'
import { type Block, type Breaks, inline, parse } from './markdown'

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

type Copyable = Extract<Block, { kind: 'code' | 'copy' }>

// The last code or copy block in the reply, inside a list or a quote too.
function lastOf<K extends Copyable['kind']>(blocks: Block[], kind: K): Extract<Block, { kind: K }> | undefined {
  for (const block of blocks.toReversed()) {
    if (block.kind === kind) return block as Extract<Block, { kind: K }>
    const inner =
      block.kind === 'quote'
        ? lastOf(block.blocks, kind)
        : block.kind === 'list'
          ? lastOf(block.items.flatMap(item => item.blocks), kind)
          : undefined
    if (inner !== undefined) return inner
  }

  return undefined
}

async function copy($: EngineInterface, text: string, what: string): Promise<void> {
  const copied = await $.ui.copy({ text, surface: 'terminal' })
  $.ui.toast(copied.isCopied ? `Copied ${what}.` : `Couldn't copy ${what} (${copied.reason}).`)
}

export const register: Register = on => {
  // Replies on the terminal only: the apps draw markdown as rich text of
  // their own. A summary of the model's text keeps the engine's row, which
  // marks it as one.
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary) return next(e)
    const blocks = parseOnce(e.props.text, 'space')
    if (blocks.length === 0) return next(e)

    const el = $.ui.resolve(e)
    const { Box, Text } = el
    const d: Draw = { el, codes: 0, copy: (text, what) => void copy($, text, what) }
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
    const d: Draw = { el, codes: 0, copy: (text, what) => void copy($, text, what) }
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
    await $.command.register({
      name: 'reply-style',
      description: "Copy Claude's last reply, or the last code block or draft in it",
      argumentHint: 'copy [code|draft]',
      immediate: true,
    })

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

    const blocks = parse(reply.text)
    if (what === 'draft') {
      const draft = lastOf(blocks, 'copy')
      if (draft === undefined) $.ui.toast('The last reply has no draft.')
      else await copy($, draft.text, draft.label ? `“${draft.label}”` : 'the last draft')

      return {}
    }

    const code = lastOf(blocks, 'code')
    if (code === undefined) $.ui.toast('The last reply has no code block.')
    else await copy($, code.source, 'the last code block')

    return {}
  })
}
