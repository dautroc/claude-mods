import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import { type BarTone, drawBar, drawNothing, toneOf } from './bar'
import { SHAPE } from './state'

type Engine = EngineInterface

// Tools whose rows the engine draws in full, whatever their time.
export const KEEP_TOOLS = new Set([
  'ExitPlanMode',
  'AskUserQuestion',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'SendUserMessage',
])

// The start of the message a refused call's output carries.
export const REFUSED_PREFIX = "The user doesn't want to proceed with this tool use"

// Read by the drawing so a running call's bar grows; the ticker writes it.
const now = atom({ plugin: 'progress-bars', key: 'now' } as const, 0)

// How long a call has taken, or undefined when the mod can't establish it.
// A running call is measured up to now.
async function toolUseMs($: Engine, id: string, isRunning: boolean): Promise<number | undefined> {
  const call = atom({ plugin: 'progress-bars', key: 'calls', id } as const, null, { shape: SHAPE })
  const time = await read($, call)
  if (!time) {
    return undefined
  }
  if (isRunning) {
    await read($, now)

    return (await $.clock.now()) - time.start
  }
  if (time.end === undefined) {
    return undefined
  }

  return time.end - time.start
}

type BarRow = {
  tool: string
  tool_use_id: string
  isRunning: boolean
  isErrored: boolean
  isInterrupted: boolean
  output?: unknown
  isExpanded?: boolean
}

// The one decision both ToolUse and ToolResult make, so the bar and the
// hidden result block can't drift apart. Undefined keeps the engine's drawing.
async function barFor(
  $: Engine,
  e: RenderInput<'ToolUse' | 'ToolResult'>,
  row: BarRow,
): Promise<{ ms: number; tone: BarTone } | undefined> {
  if (e.surface !== 'terminal' || row.isExpanded === true || KEEP_TOOLS.has(row.tool)) {
    return undefined
  }
  if (row.isErrored && typeof row.output === 'string' && row.output.startsWith(REFUSED_PREFIX)) {
    return undefined
  }
  const ms = await toolUseMs($, row.tool_use_id, row.isRunning)
  if (ms === undefined) {
    return undefined
  }

  return { ms, tone: toneOf(row) }
}

export const register: Register = on => {
  // Records when a main-loop tool call starts and ends. A fault here never
  // blocks the call: the tool runs and answers as it would without the mod.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      return next(e)
    }

    const call = atom({ plugin: 'progress-bars', key: 'calls', id: e.tool_use_id } as const, null, { shape: SHAPE })
    const start = await $.clock.now()
    await update($, call, () => ({ start }))
    try {
      return await next(e)
    } finally {
      const end = await $.clock.now()
      await update($, call, () => ({ start, end }))
    }
  }).catch(($, e, next) => next(e))

  // A standalone tool row on the terminal is a bar of its time.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const hit = await barFor($, e, e.props)

    return hit ? drawBar($, e, hit.ms, hit.tone) : next(e)
  }).catch(($, e, next) => next(e))

  // The result under a bar is hidden, since the bar stands for the call. A
  // result has no running or interrupted flag, but neither changes whether
  // a bar is drawn.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const hit = await barFor($, e, { ...e.props, isRunning: false, isInterrupted: false })

    return hit ? drawNothing($, e) : next(e)
  }).catch(($, e, next) => next(e))
}
