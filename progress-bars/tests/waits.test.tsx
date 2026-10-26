import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentStatus, On, StateWrite } from 'claude-code'

import { barCells } from '../hooks/scale'
import { waitFor } from '../hooks/waits'
import { answerProcesses, engine, launchAgent, readBar, sessionOn, turnLine, uid } from './helpers'

const T0 = 1_800_000_000_000
// The start of the turn whose footer waits, and the moment it ended.
const T = 100_000

describe('waitFor', () => {
  test('one agent still out grows the wait', () => {
    expect(waitFor(T, [{ id: 'a1', toolUseId: 't1', start: T - 5_000 }], [], T + 30_000)).toEqual({ ms: 30_000, tone: 'running' })
  })

  test('the wait ends when the next turn starts after its agent ended', () => {
    const runs = [{ id: 'a1', toolUseId: 't1', start: T - 5_000, end: T + 40_000, outcome: 'completed' as const }]

    expect(waitFor(T, runs, [T + 40_050], T + 40_100)).toEqual({ ms: 40_000, tone: 'done' })
  })

  test('the wait stops at the next turn, and an agent still running does not colour it', () => {
    const runs = [
      { id: 'a1', toolUseId: 't1', start: T - 1_000, end: T + 40_000, outcome: 'completed' as const },
      { id: 'a2', toolUseId: 't2', start: T - 1_000 },
    ]

    expect(waitFor(T, runs, [T + 40_000], T + 50_000)).toEqual({ ms: 40_000, tone: 'done' })
  })

  test('an agent that failed makes the wait failed', () => {
    const runs = [{ id: 'a1', toolUseId: 't1', start: T - 1_000, end: T + 20_000, outcome: 'failed' as const }]

    expect(waitFor(T, runs, [], T + 20_000)).toEqual({ ms: 20_000, tone: 'failed' })
  })

  test('an agent that was killed makes the wait stopped', () => {
    const runs = [{ id: 'a1', toolUseId: 't1', start: T - 1_000, end: T + 20_000, outcome: 'killed' as const }]

    expect(waitFor(T, runs, [], T + 20_000)).toEqual({ ms: 20_000, tone: 'stopped' })
  })

  test('an agent launched after the turn, or ended before it, does not count', () => {
    const runs = [
      { id: 'late', toolUseId: 't1', start: T + 1 },
      { id: 'early', toolUseId: 't2', start: T - 9_000, end: T - 1, outcome: 'completed' as const },
    ]

    expect(waitFor(T, runs, [], T + 1_000)).toBeNull()
  })
})

// Answers the session file lookups so the footer for `requestId` is the one
// line given.
function sessionWith(on: On, session: string, line: string) {
  sessionOn(on, session)

  return answerProcesses(on, session, { text: `${line}\n` })
}

async function mountFooter($: Engine, requestId: string, props: Record<string, unknown>, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({
    plugin: 'progress-bars',
    surface,
    component: 'TurnDuration',
    requestId,
    props: { word: 'Baked', durationMs: 0, ...props },
  } as never)
}

describe('the turn footer as a bar', () => {
  test('a footer whose turn left an agent out grows, then shows the wait', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    sessionWith(on, 's-wait', turnLine(uid(1), T0 + 10_000, 1))
    on('turn.start', () => ({ turnId: 'main-2' }))
    on('turn.complete', () => ({ text: '' }))
    await launchAgent($, on, 'ag1')
    await clock.advance(40_000)

    const ui = await mountFooter($, uid(1), { durationMs: 10_000 })
    expect(await readBar(ui)).toEqual({ glyphs: barCells(30_000), color: 'claude', time: '30s' })
    await clock.advance(5_000)
    await ui.redraw()
    expect(await readBar(ui)).toEqual({ glyphs: barCells(35_000), color: 'claude', time: '35s' })

    await $.turn.complete({ agentId: 'ag1', turnId: 'ag1-1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    await clock.advance(50)
    await $.turn.start({ text: '', turnId: 'main-2' } as never)
    await ui.redraw()
    expect(await readBar(ui)).toEqual({ glyphs: barCells(35_000), color: 'success', time: '35s' })
    await ui.unmount()
  })

  test('a plain footer shows the turn\'s time', async ($, on) => {
    mock.clock(on, { now: T0 })
    sessionWith(on, 's-plain', turnLine(uid(2), T0 + 10_000, 0))

    const ui = await mountFooter($, uid(2), { durationMs: 14_000 })
    expect(await readBar(ui)).toEqual({ glyphs: barCells(14_000), color: 'success', time: '14s' })
    await ui.unmount()
  })

  test('a resumed footer shows the turn\'s time', async ($, on) => {
    mock.clock(on, { now: T0 })
    sessionWith(on, 's-resumed', turnLine(uid(3), T0 + 10_000, 2))

    const ui = await mountFooter($, uid(3), { durationMs: 9_000 })
    expect(await readBar(ui)).toEqual({ glyphs: barCells(9_000), color: 'success', time: '9s' })
    await ui.unmount()
  })

  test('kept as the engine draws it, expanded', async ($, on) => {
    engine(on)
    mock.clock(on, { now: T0 })
    sessionWith(on, 's-expanded', turnLine(uid(4), T0 + 10_000, 1))

    const ui = await mountFooter($, uid(4), { durationMs: 10_000, isExpanded: true })
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('kept as the engine draws it, on a desktop surface', async ($, on) => {
    engine(on)
    mock.clock(on, { now: T0 })
    sessionWith(on, 's-desktop', turnLine(uid(5), T0 + 10_000, 1))

    const ui = await mountFooter($, uid(5), { durationMs: 10_000 }, 'desktop')
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })
})

describe('a footer drawn before its line is written', () => {
  test('it turns into the running wait once the line appears, with no explicit redraw', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    sessionOn(on, 's-late-line')
    let text = ''
    answerProcesses(on, 's-late-line', { text: () => text })
    on('turn.start', () => ({ turnId: 'main-2' }))
    on('turn.complete', () => ({ text: '' }))
    await launchAgent($, on, 'ag-late')
    await clock.advance(40_000)

    const ui = await mountFooter($, uid(30), { durationMs: 10_000 })
    expect(await readBar(ui)).toEqual({ glyphs: barCells(10_000), color: 'success', time: '10s' })

    text = `${turnLine(uid(30), T0 + 10_000, 1)}\n`
    await clock.advance(1_500)
    expect(await readBar(ui)).toEqual({ glyphs: barCells(31_500), color: 'claude', time: '31s' })
    await ui.unmount()
  })

  test('with no agent recorded, no process runs at all', async ($, on) => {
    mock.clock(on, { now: T0 })
    sessionOn(on, 's-no-agents')
    const ran = answerProcesses(on, 's-no-agents', { text: `${turnLine(uid(31), T0 + 10_000, 1)}\n` })

    const ui = await mountFooter($, uid(31), { durationMs: 12_000 })
    expect(await readBar(ui)).toEqual({ glyphs: barCells(12_000), color: 'success', time: '12s' })
    await ui.unmount()

    expect(ran).toEqual([])
  })
})

describe('an agent whose end never arrives', () => {
  // The ticker reads the agents once a tick; a stopped timer reads nothing.
  function countAgentReads(on: On) {
    const reads = { count: 0 }
    on('state.get', (_, e, next) => {
      if (e.key === 'agents') {
        reads.count += 1
      }

      return next(e)
    })

    return reads
  }

  test('one listed as failed turns the footer red, and the ticker stops', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const reads = countAgentReads(on)
    sessionOn(on, 's-lost-failed')
    answerProcesses(on, 's-lost-failed', { text: `${turnLine(uid(32), T0 + 10_000, 1)}\n` })
    on('turn.start', () => ({ turnId: 'main-2' }))
    on('turn.complete', () => ({ text: '' }))
    const listing = { status: 'running' as AgentStatus | null }
    await launchAgent($, on, 'ag-lost-failed', listing)
    await clock.advance(40_000)

    const ui = await mountFooter($, uid(32), { durationMs: 10_000 })
    expect(await readBar(ui)).toEqual({ glyphs: barCells(30_000), color: 'claude', time: '30s' })
    listing.status = 'failed'
    await clock.advance(1_000)
    expect(await readBar(ui)).toEqual({ glyphs: barCells(30_500), color: 'error', time: '30s' })

    await clock.advance(1_000)
    const settled = reads.count
    await clock.advance(5_000)
    expect(reads.count).toBe(settled)
    await ui.unmount()
  })

  test('one no longer listed counts as done, and the ticker stops', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const reads = countAgentReads(on)
    sessionOn(on, 's-lost-dropped')
    answerProcesses(on, 's-lost-dropped', { text: `${turnLine(uid(33), T0 + 10_000, 1)}\n` })
    on('turn.start', () => ({ turnId: 'main-2' }))
    on('turn.complete', () => ({ text: '' }))
    const listing = { status: 'running' as AgentStatus | null }
    await launchAgent($, on, 'ag-lost-dropped', listing)
    await clock.advance(40_000)

    const ui = await mountFooter($, uid(33), { durationMs: 10_000 })
    listing.status = null
    await clock.advance(1_000)
    expect(await readBar(ui)).toEqual({ glyphs: barCells(30_500), color: 'success', time: '30s' })

    await clock.advance(1_000)
    const settled = reads.count
    await clock.advance(5_000)
    expect(reads.count).toBe(settled)
    await ui.unmount()
  })
})

// Records the writes the mod makes to one state key, and lets them through.
function writesTo(on: On, key: string) {
  const seen: StateWrite[] = []
  on('state.set', (_, e, next) => {
    if (e.key === key) {
      seen.push(e)
    }

    return next(e)
  })

  return seen
}

// Ends a background agent's turn: `over` sets the outcome fields.
function completeAgent($: Engine, agentId: string, over: Record<string, unknown>) {
  return $.turn.complete({ agentId, turnId: `${agentId}-t`, answer: '', durationMs: 1, isAborted: false, reason: 'answer', ...over } as never)
}

// Starts the main loop's next turn.
function nextTurn($: Engine) {
  return $.turn.start({ text: '', turnId: 'main-next' } as never)
}

// A footer whose turn left `agentId` running, and the clock 30 s into the wait.
async function waitingOn($: Engine, on: On, clock: { advance: (ms: number) => Promise<void> }, session: string, uuid: string, agentId: string) {
  sessionWith(on, session, turnLine(uuid, T0 + 10_000, 1))
  on('turn.start', () => ({ turnId: 'main-next' }))
  on('turn.complete', () => ({ text: '' }))
  await launchAgent($, on, agentId)
  await clock.advance(40_000)
}

describe('the agent outcome mapping through the footer', () => {
  test('an aborted agent makes the wait warning', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    await waitingOn($, on, clock, 's-killed', uid(10), 'ag10')
    await completeAgent($, 'ag10', { isAborted: true, reason: 'aborted' })
    await nextTurn($)

    const ui = await mountFooter($, uid(10), { durationMs: 10_000 })
    expect(await readBar(ui)).toEqual({ glyphs: barCells(30_000), color: 'warning', time: '30s' })
    await ui.unmount()
  })

  test('an agent whose turn errored makes the wait red', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    await waitingOn($, on, clock, 's-error', uid(11), 'ag11')
    await completeAgent($, 'ag11', { reason: 'error' })
    await nextTurn($)

    const ui = await mountFooter($, uid(11), { durationMs: 10_000 })
    expect(await readBar(ui)).toEqual({ glyphs: barCells(30_000), color: 'error', time: '30s' })
    await ui.unmount()
  })

  test('an agent whose turn was refused makes the wait red', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    await waitingOn($, on, clock, 's-refusal', uid(12), 'ag12')
    await completeAgent($, 'ag12', { reason: 'refusal', refusal: { category: null, explanation: null } })
    await nextTurn($)

    const ui = await mountFooter($, uid(12), { durationMs: 10_000 })
    expect(await readBar(ui)).toEqual({ glyphs: barCells(30_000), color: 'error', time: '30s' })
    await ui.unmount()
  })
})

describe('the turn hooks', () => {
  test('a mounted footer turns green without a redraw once its agent ends', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    await waitingOn($, on, clock, 's-live', uid(13), 'ag13')

    const ui = await mountFooter($, uid(13), { durationMs: 10_000 })
    expect(await readBar(ui)).toEqual({ glyphs: barCells(30_000), color: 'claude', time: '30s' })
    await completeAgent($, 'ag13', {})
    await nextTurn($)

    expect(await readBar(ui)).toEqual({ glyphs: barCells(30_000), color: 'success', time: '30s' })
    await ui.unmount()
  })

  test('a subagent turn start is not recorded', async ($, on) => {
    mock.clock(on, { now: T0 })
    const wrote = writesTo(on, 'turnStarts')
    on('turn.start', () => ({ turnId: 'sub-t' }))

    await $.turn.start({ text: '', turnId: 'sub-t', agentId: 'sub13' } as never)

    expect(wrote).toEqual([])
  })

  test('turnStarts keeps every main-loop start', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const wrote = writesTo(on, 'turnStarts')
    on('turn.start', () => ({ turnId: 'main' }))

    for (let i = 0; i < 201; i++) {
      await clock.advance(1)
      await $.turn.start({ text: '', turnId: `main-${i}` } as never)
    }

    const last = wrote.at(-1)?.value as { value: number[] }
    expect(last.value).toHaveLength(201)
    expect(last.value[0]).toBe(T0 + 1)
  })

  test('an async Agent launch is recorded as an agent', async ($, on) => {
    mock.clock(on, { now: T0 })
    const wrote = writesTo(on, 'agents')
    on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag14', description: 'd' } }))

    await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)

    expect(wrote.length).toBeGreaterThan(0)
  })

  test('a denied Agent call records no agent', async ($, on) => {
    mock.clock(on, { now: T0 })
    const wrote = writesTo(on, 'agents')
    on('tool.call', { tool: 'Agent' }, () => ({ deny: 'not now' } as never))

    const out = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)

    expect(out).toMatchObject({ deny: 'not now' })
    expect(wrote).toEqual([])
  })

  test('an Agent call that completes records no agent', async ($, on) => {
    mock.clock(on, { now: T0 })
    const wrote = writesTo(on, 'agents')
    on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'completed', agentId: 'ag15', description: 'd' } } as never))

    await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)

    expect(wrote).toEqual([])
  })
})
