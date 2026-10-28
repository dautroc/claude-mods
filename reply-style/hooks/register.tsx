import type { EngineInterface, Register } from 'claude-code'

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

// The last code block in the reply, inside a list or a quote too.
function lastCode(blocks: Block[]): string | undefined {
  for (const block of blocks.toReversed()) {
    if (block.kind === 'code') return block.source
    const inner =
      block.kind === 'quote'
        ? lastCode(block.blocks)
        : block.kind === 'list'
          ? lastCode(block.items.flatMap(item => item.blocks))
          : undefined
    if (inner !== undefined) return inner
  }

  return undefined
}

async function copy($: EngineInterface, text: string, what: string): Promise<void> {
  const copied = await $.ui.copy({ text, surface: 'terminal' })
  $.ui.toast(copied.isCopied ? `Copied the ${what}.` : `Couldn't copy the ${what} (${copied.reason}).`)
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
    const d: Draw = { el, codes: 0, copy: source => void copy($, source, 'code block') }
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
    const d: Draw = { el, codes: 0, copy: source => void copy($, source, 'code block') }
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

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'reply-style',
      description: "Copy Claude's last reply, or with code the last code block in it",
      argumentHint: 'copy [code]',
      immediate: true,
    })

    return next(e)
  })

  // Answered with a toast and no output row, which the model would read.
  on('command.run', { command: 'reply-style' }, async ($, e) => {
    const [verb, what, ...rest] = e.args.trim().split(/\s+/)
    if (verb !== 'copy' || (what !== undefined && what !== 'code') || rest.length > 0) {
      $.ui.toast('Usage: /reply-style copy [code]')

      return {}
    }

    const reply = (await $.session.messages()).findLast(m => m.role === 'assistant' && m.text.trim() !== '')
    if (reply === undefined) {
      $.ui.toast('There is no reply to copy yet.')

      return {}
    }
    if (what === undefined) {
      await copy($, reply.text, 'last reply')

      return {}
    }

    const code = lastCode(parse(reply.text))
    if (code === undefined) $.ui.toast('The last reply has no code block.')
    else await copy($, code, 'last code block')

    return {}
  })
}
