import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, StateWrite } from 'claude-code'

import { barCells } from '../hooks/scale'
import { answerProcesses, engine, readBar, sessionOn, toolResultLine, toolUseLine } from './helpers'

const T0 = 1_800_000_000_000

// Records every write the mod makes to state, and lets it through to the store.
function writes(on: On) {
  const seen: StateWrite[] = []
  on('state.set', (_, e, next) => {
    seen.push(e)

    return next(e)
  })

  return seen
}

// Stands for the engine's Bash tool. Each call's `command` names how long it
// takes, in `sleeps`, and the tool_use_id it was given is kept in `ids`.
function bashTool(on: On, clock: { sleep: (ms: number) => Promise<void> }) {
  const sleeps: Record<string, number> = {}
  const ids: Record<string, string> = {}
  on('tool.call', { tool: 'Bash' }, async (_, e) => {
    const { command } = e as unknown as { command: string }
    ids[command] = e.tool_use_id
    await clock.sleep(sleeps[command] ?? 0)

    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })

  return { sleeps, ids }
}

// One ToolGroupCall: a finished call unless `over` says otherwise.
function row(id: string | undefined, over: Record<string, unknown> = {}) {
  return {
    tool_use_id: id,
    tool: 'Bash',
    input: { command: 'make test' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    ...over,
  }
}

async function mountGroup($: Engine, calls: unknown[], over: Record<string, unknown> = {}, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({
    plugin: 'progress-bars',
    surface,
    component: 'ToolGroup',
    requestId: `brief-collapsed-${crypto.randomUUID()}`,
    props: { calls, isActive: false, isExpanded: false, ...over },
  } as never)
}

describe('a run of calls as one bar', () => {
  test('two parallel calls show the span, not the sum', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    writes(on)
    const { sleeps, ids } = bashTool(on, clock)
    sleeps.a = 10_000
    sleeps.b = 4_000

    const a = $.tool.call({ tool: 'Bash', command: 'a' })
    await clock.advance(2_000)
    const b = $.tool.call({ tool: 'Bash', command: 'b' })
    await clock.advance(4_000)
    await b
    await clock.advance(4_000)
    await a

    const ui = await mountGroup($, [row(ids.a), row(ids.b)])
    expect(await readBar(ui)).toEqual({ glyphs: barCells(10_000), color: 'success', time: '10s' })
    await ui.unmount()
  })

  test('a group with an errored call is red once all have ended', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    writes(on)
    const { sleeps, ids } = bashTool(on, clock)
    sleeps.a = 10_000
    sleeps.b = 4_000

    const a = $.tool.call({ tool: 'Bash', command: 'a' })
    await clock.advance(2_000)
    const b = $.tool.call({ tool: 'Bash', command: 'b' })
    await clock.advance(4_000)
    await b
    await clock.advance(4_000)
    await a

    const ui = await mountGroup($, [row(ids.a), row(ids.b, { isErrored: true })])
    expect(await readBar(ui)).toEqual({ glyphs: barCells(10_000), color: 'error', time: '10s' })
    await ui.unmount()
  })

  test('a group is accent while one call still runs, even after another errored', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    writes(on)
    const { sleeps, ids } = bashTool(on, clock)
    sleeps.a = 60_000
    sleeps.b = 1_000

    const a = $.tool.call({ tool: 'Bash', command: 'a' })
    const b = $.tool.call({ tool: 'Bash', command: 'b' })
    await clock.advance(1_000)
    await b
    await clock.advance(4_000)

    const ui = await mountGroup($, [row(ids.a, { isRunning: true }), row(ids.b, { isErrored: true })])
    expect(await readBar(ui)).toEqual({ glyphs: barCells(5_000), color: 'claude', time: '5s' })
    await clock.advance(55_000)
    await ui.redraw()
    expect(await readBar(ui)).toEqual({ glyphs: barCells(60_000), color: 'claude', time: '1m 0s' })
    await ui.unmount()
    await a
  })

  test('an interrupted call makes the group yellow', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    writes(on)
    const { sleeps, ids } = bashTool(on, clock)
    sleeps.a = 14_000
    sleeps.b = 14_000

    const a = $.tool.call({ tool: 'Bash', command: 'a' })
    const b = $.tool.call({ tool: 'Bash', command: 'b' })
    await clock.advance(14_000)
    await a
    await b

    const ui = await mountGroup($, [row(ids.a), row(ids.b, { isInterrupted: true, isErrored: true })])
    expect(await readBar(ui)).toEqual({ glyphs: barCells(14_000), color: 'warning', time: '14s' })
    await ui.unmount()
  })

  test('a group with no calls draws nothing', async ($, on) => {
    writes(on)
    const ui = await mountGroup($, [])

    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  })

  test('a group with a call that has no tool_use_id keeps the engine drawing', async ($, on) => {
    engine(on)
    const ui = await mountGroup($, [row(undefined)])

    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('a not-yet-started running call is left out of the span, so the bar does not flicker back to the engine', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    engine(on)
    writes(on)
    const ran = answerProcesses(on, 'S-group-early')
    sessionOn(on, 'S-group-early')
    const { sleeps, ids } = bashTool(on, clock)
    sleeps.a = 4_000

    const a = $.tool.call({ tool: 'Bash', command: 'a' })
    await clock.advance(4_000)
    await a
    await clock.advance(1_000)

    const ui = await mountGroup($, [row(ids.a), row('toolu_group_not_yet', { isRunning: true })])
    expect(await readBar(ui)).toEqual({ glyphs: barCells(5_000), color: 'claude', time: '5s' })
    expect(ran).toEqual([])
    await ui.unmount()
  })

  test('a group of only not-yet-started running calls keeps the engine drawing', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    const ran = answerProcesses(on, 'S-group-early-2')
    sessionOn(on, 'S-group-early-2')

    const ui = await mountGroup($, [row('toolu_group_early_1', { isRunning: true })])
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    expect(ran).toEqual([])
    await ui.unmount()
  })

  test('an ended call with no recorded time takes its time from the session file', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    writes(on)
    sessionOn(on, 'S-group-history')
    answerProcesses(on, 'S-group-history', {
      text: `${toolUseLine('toolu_group_old', 'Bash', T0 + 1_000)}\n${toolResultLine('toolu_group_old', T0 + 9_000)}\n`,
    })
    const { sleeps, ids } = bashTool(on, clock)
    sleeps.a = 4_000

    const a = $.tool.call({ tool: 'Bash', command: 'a' })
    await clock.advance(4_000)
    await a

    const ui = await mountGroup($, [row(ids.a), row('toolu_group_old')])
    expect(await readBar(ui)).toEqual({ glyphs: barCells(9_000), color: 'success', time: '9s' })
    await ui.unmount()
  })

  test('a group the mod never saw draws from the session file', async ($, on) => {
    mock.clock(on, { now: T0 })
    sessionOn(on, 'S-group-unseen')
    answerProcesses(on, 'S-group-unseen', {
      text: [
        toolUseLine('toolu_unseen_a', 'Bash', T0),
        toolUseLine('toolu_unseen_b', 'Bash', T0 + 2_000),
        toolResultLine('toolu_unseen_b', T0 + 5_000),
        toolResultLine('toolu_unseen_a', T0 + 7_000),
        '',
      ].join('\n'),
    })

    const ui = await mountGroup($, [row('toolu_unseen_a'), row('toolu_unseen_b')])
    expect(await readBar(ui)).toEqual({ glyphs: barCells(7_000), color: 'success', time: '7s' })
    await ui.unmount()
  })

  describe('kept as the engine draws them', () => {
    test('an expanded group', async ($, on) => {
      engine(on)
      const ui = await mountGroup($, [row('toolu_never_called')], { isExpanded: true })

      expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
      await ui.unmount()
    })

    test('a desktop surface', async ($, on) => {
      engine(on)
      const ui = await mountGroup($, [row('toolu_never_called')], {}, 'desktop')

      expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
      await ui.unmount()
    })

    test('a call with no recorded time', async ($, on) => {
      engine(on)
      const ui = await mountGroup($, [row('toolu_never_called')])

      expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
      await ui.unmount()
    })
  })
})
