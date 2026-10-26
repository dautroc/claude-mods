import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput, ToolGroupCall } from 'claude-code'

import { type BarTone, drawBar, drawNothing, toneOf } from './bar'
import { historyTimes } from './history'
import { SHAPE } from './state'
import { ensureTicking, markEnded, markStarted } from './ticker'

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

type Known = { start?: number; end?: number }

// The start and end of each row's call: from the state, and for what the state
// lacks, from the session file. A running row needs only its start.
async function knownTimes($: Engine, rows: readonly { tool_use_id: string; isRunning: boolean }[]): Promise<Map<string, Known>> {
  const known = new Map<string, Known>()
  const lacking: string[] = []
  for (const row of rows) {
    const call = atom({ plugin: 'progress-bars', key: 'calls', id: row.tool_use_id } as const, null, { shape: SHAPE })
    const time = await read($, call)
    known.set(row.tool_use_id, { start: time?.start, end: time?.end })
    if (time?.start === undefined || (!row.isRunning && time.end === undefined)) {
      lacking.push(row.tool_use_id)
    }
  }
  if (lacking.length > 0) {
    const history = await historyTimes($, lacking)
    for (const id of lacking) {
      const found = history.get(id)
      const mine = known.get(id) ?? {}
      mine.start ??= found?.start
      mine.end ??= found?.end
      known.set(id, mine)
    }
  }

  return known
}

// How long a call has taken, or undefined when the mod can't establish it.
// A running call is measured up to now.
async function toolUseMs($: Engine, id: string, isRunning: boolean): Promise<number | undefined> {
  const { start, end } = (await knownTimes($, [{ tool_use_id: id, isRunning }])).get(id) ?? {}
  if (start === undefined) {
    return undefined
  }
  if (isRunning) {
    await read($, now)

    return (await $.clock.now()) - start
  }
  if (end === undefined) {
    return undefined
  }

  return end - start
}

// The span of a run of calls: from the earliest start to the latest end, or
// to now while any call runs. Undefined when the mod can't establish it.
async function groupSpan($: Engine, calls: readonly ToolGroupCall[]): Promise<{ ms: number; isRunning: boolean } | undefined> {
  if (calls.length === 0) {
    return undefined
  }
  const rows: { tool_use_id: string; isRunning: boolean }[] = []
  for (const row of calls) {
    if (row.tool_use_id === undefined) {
      return undefined
    }
    rows.push({ tool_use_id: row.tool_use_id, isRunning: row.isRunning })
  }
  const known = await knownTimes($, rows)

  let start = Infinity
  let end = -Infinity
  let isRunning = false
  for (const row of rows) {
    const time = known.get(row.tool_use_id)
    if (time?.start === undefined) {
      return undefined
    }
    start = Math.min(start, time.start)
    if (row.isRunning) {
      isRunning = true
    } else if (time.end === undefined) {
      return undefined
    } else {
      end = Math.max(end, time.end)
    }
  }
  if (isRunning) {
    await read($, now)
    end = await $.clock.now()
  }

  return { ms: end - start, isRunning }
}

// The tone of a run: the same order as one row's, across all its calls.
function groupTone(calls: readonly ToolGroupCall[]): BarTone {
  return toneOf({
    isRunning: calls.some(row => row.isRunning),
    isErrored: calls.some(row => row.isErrored),
    isInterrupted: calls.some(row => row.isInterrupted),
  })
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
    markStarted(e.tool_use_id)
    ensureTicking($)
    try {
      return await next(e)
    } finally {
      markEnded(e.tool_use_id)
      const end = await $.clock.now()
      await update($, call, () => ({ start, end }))
    }
  }).catch(($, e, next) => next(e))

  // A session that starts while an agent or call is still out, after a reload,
  // needs the ticker running.
  on('session.start', ($, e, next) => {
    ensureTicking($)

    return next(e)
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

  // A run of calls is one bar of its span, whether or not isCallsOnly is set.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded === true) {
      return next(e)
    }
    if (e.props.calls.length === 0) {
      return drawNothing($, e)
    }
    const span = await groupSpan($, e.props.calls)

    return span ? drawBar($, e, span.ms, groupTone(e.props.calls)) : next(e)
  }).catch(($, e, next) => next(e))
}
