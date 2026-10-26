import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { barCells } from '../hooks/scale'
import { waitFor } from '../hooks/waits'
import { engine, readBar } from './helpers'

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
  on('session.id', () => ({ value: session }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('process.run', (_, e) => {
    const isFind = e.argv[0] === 'find'
    const stdout = isFind ? `/home/u/.claude/projects/p/${session}.jsonl\n` : line

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

// The turn_duration line of a turn that ended at `at`, with `pending` agents
// it left running.
function footerLine(uuid: string, at: number, pending: number) {
  return JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    uuid,
    timestamp: new Date(at).toISOString(),
    durationMs: 10_000,
    pendingBackgroundAgentCount: pending,
  })
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

// Launches a background agent from the main loop, which returns at once.
async function launchAgent($: Engine, on: On, agentId: string) {
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId, description: 'd' } }))
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)
}

describe('the turn footer as a bar', () => {
  test('a footer whose turn left an agent out grows, then shows the wait', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    sessionWith(on, 's-wait', footerLine('u1', T0 + 10_000, 1))
    on('turn.start', () => ({ turnId: 'main-2' }))
    on('turn.complete', () => ({ text: '' }))
    await launchAgent($, on, 'ag1')
    await clock.advance(40_000)

    const ui = await mountFooter($, 'u1', { durationMs: 10_000 })
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
    sessionWith(on, 's-plain', footerLine('u2', T0 + 10_000, 0))

    const ui = await mountFooter($, 'u2', { durationMs: 14_000 })
    expect(await readBar(ui)).toEqual({ glyphs: barCells(14_000), color: 'success', time: '14s' })
    await ui.unmount()
  })

  test('a resumed footer shows the turn\'s time', async ($, on) => {
    mock.clock(on, { now: T0 })
    sessionWith(on, 's-resumed', footerLine('u3', T0 + 10_000, 2))

    const ui = await mountFooter($, 'u3', { durationMs: 9_000 })
    expect(await readBar(ui)).toEqual({ glyphs: barCells(9_000), color: 'success', time: '9s' })
    await ui.unmount()
  })

  test('kept as the engine draws it, expanded', async ($, on) => {
    engine(on)
    mock.clock(on, { now: T0 })
    sessionWith(on, 's-expanded', footerLine('u4', T0 + 10_000, 1))

    const ui = await mountFooter($, 'u4', { durationMs: 10_000, isExpanded: true })
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('kept as the engine draws it, on a desktop surface', async ($, on) => {
    engine(on)
    mock.clock(on, { now: T0 })
    sessionWith(on, 's-desktop', footerLine('u5', T0 + 10_000, 1))

    const ui = await mountFooter($, 'u5', { durationMs: 10_000 }, 'desktop')
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })
})
