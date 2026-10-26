import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, StateWrite } from 'claude-code'

import { barCells } from '../hooks/scale'
import { KEEP_TOOLS, REFUSED_PREFIX } from '../hooks/register'
import { engine, readBar } from './helpers'

const T0 = 1_800_000_000_000

// Stands for the engine's tool: it takes 14 seconds and answers a Bash
// result, recording the tool_use_id it was given.
function bash(on: On, clock: { sleep: (ms: number) => Promise<void> }, seen: { id?: string }) {
  on('tool.call', { tool: 'Bash' }, async (_, e) => {
    seen.id = e.tool_use_id
    await clock.sleep(14_000)

    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
}

// Records every write the mod makes to state, and lets it through to the store.
function writes(on: On) {
  const seen: StateWrite[] = []
  on('state.set', (_, e, next) => {
    seen.push(e)

    return next(e)
  })

  return seen
}

describe('timing', () => {
  test('records start and end of a main-loop call', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const seen: { id?: string } = {}
    const wrote = writes(on)
    bash(on, clock, seen)

    const call = $.tool.call({ tool: 'Bash', command: 'make test' })
    await clock.advance(14_000)
    await call

    const id = seen.id
    expect(wrote.filter(w => w.id === id).map(w => w.value)).toEqual([
      { shape: 'progress-bars-1', value: { start: T0 } },
      { shape: 'progress-bars-1', value: { start: T0, end: T0 + 14_000 } },
    ])
  })

  test("ignores a subagent's call", async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const seen: { id?: string } = {}
    const wrote = writes(on)
    bash(on, clock, seen)

    const call = $.tool.call({ tool: 'Bash', command: 'make test', agentId: 'a1' })
    await clock.advance(14_000)
    await call

    expect(wrote.filter(w => w.id === seen.id)).toEqual([])
  })

  test('a fault in the mod never blocks the call', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    // The first write (the start) lands; the second (the end, in finally,
    // after next has returned) is refused. The harness does not show whether
    // a refused write throws into the hook or the engine skips it, so this
    // test cannot tell the .catch apart: it checks that the result still comes
    // back and the tool ran once.
    // Only the call's own writes are counted: the ticker's clock writes pass.
    let writesSeen = 0
    on('state.set', (_, e, next) => {
      if (e.key !== 'calls') {
        return next(e)
      }

      return ++writesSeen === 1 ? { value: { isSet: true, version: 1 } } : { deny: 'refused' }
    })
    let ran = 0
    on('tool.call', { tool: 'Bash' }, async () => {
      ran += 1
      await clock.sleep(14_000)

      return { result: { stdout: 'ok', stderr: '', interrupted: false } }
    })

    const call = $.tool.call({ tool: 'Bash', command: 'make test' })
    await clock.advance(14_000)
    const result = await call
    expect(result.result).toMatchObject({ stdout: 'ok' })
    expect(ran).toBe(1)
    expect(writesSeen).toBe(2)
  })
})

// A ToolUse row's props: a finished call unless `over` says otherwise.
function useProps(id: string, over: Record<string, unknown> = {}) {
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

// Times a Bash call of `ms` and returns its id once it has ended.
async function timedCall($: Engine, on: On, ms: number, tool = 'Bash') {
  const clock = mock.clock(on, { now: T0 })
  const seen: { id?: string } = {}
  writes(on)
  on('tool.call', { tool: tool as 'Bash' }, async (_, e) => {
    seen.id = e.tool_use_id
    await clock.sleep(ms)

    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  const call = $.tool.call({ tool: tool as 'Bash', command: 'make test' })
  await clock.advance(ms)
  await call

  return { id: seen.id as string, clock }
}

async function mountUse($: Engine, id: string, props: Record<string, unknown>, extra: { surface?: 'terminal' | 'desktop'; viewport?: { columns: number; rows: number } } = {}) {
  return $.ui.mount({
    plugin: 'progress-bars',
    surface: extra.surface ?? 'terminal',
    component: 'ToolUse',
    requestId: id,
    props: useProps(id, props),
    viewport: extra.viewport,
  } as never)
}

describe('tool rows as bars', () => {
  test('a finished call is a green bar with its time', async ($, on) => {
    const { id } = await timedCall($, on, 14_000)
    const ui = await mountUse($, id, {})

    expect(await readBar(ui)).toEqual({ glyphs: barCells(14_000), color: 'success', time: '14s' })
    await ui.unmount()
  })

  test('a running call is an accent bar that grows', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const seen: { id?: string } = {}
    writes(on)
    bash(on, clock, seen)

    const call = $.tool.call({ tool: 'Bash', command: 'make test' })
    await clock.advance(5_000)
    const ui = await mountUse($, seen.id as string, { isRunning: true })

    expect(await readBar(ui)).toEqual({ glyphs: barCells(5_000), color: 'claude', time: '5s' })
    await clock.advance(55_000)
    await ui.redraw()
    expect(await readBar(ui)).toEqual({ glyphs: barCells(60_000), color: 'claude', time: '1m 0s' })
    await ui.unmount()
    await call
  })

  test('a failed call is red', async ($, on) => {
    const { id } = await timedCall($, on, 14_000)
    const ui = await mountUse($, id, { isErrored: true })

    expect(await readBar(ui)).toEqual({ glyphs: barCells(14_000), color: 'error', time: '14s' })
    await ui.unmount()
  })

  test('an interrupted call is yellow', async ($, on) => {
    const { id } = await timedCall($, on, 14_000)
    const ui = await mountUse($, id, { isInterrupted: true, isErrored: true })

    expect(await readBar(ui)).toEqual({ glyphs: barCells(14_000), color: 'warning', time: '14s' })
    await ui.unmount()
  })

  test('the result block under a bar draws nothing', async ($, on) => {
    const { id } = await timedCall($, on, 14_000)
    const ui = await $.ui.mount({
      plugin: 'progress-bars',
      surface: 'terminal',
      component: 'ToolResult',
      requestId: id,
      props: { tool_use_id: id, tool: 'Bash', output: { stdout: 'ok', stderr: '', interrupted: false }, isErrored: false },
    } as never)

    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  })

  // A ten-minute call ticks 1 200 times under the mock clock, so it gets more than the default 5 s.
  test('a narrow terminal shrinks the bar so bar and time fit one line', { timeoutMs: 30_000 }, async ($, on) => {
    const { id } = await timedCall($, on, 600_000)
    const ui = await mountUse($, id, {}, { viewport: { columns: 30, rows: 20 } })

    const { glyphs, time } = await readBar(ui)
    expect(glyphs + 2 + 1 + time.length).toBeLessThanOrEqual(30)
    expect(time).toBe('10m 0s')
    await ui.unmount()
  })

  describe('kept as the engine draws them', () => {
    // Each case mounts the row and its result under the engine's drawing.
    async function keeps($: Engine, id: string, use: Record<string, unknown>, surface: 'terminal' | 'desktop' = 'terminal') {
      const ui = await mountUse($, id, use, { surface })
      expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
      await ui.unmount()

      const result = await $.ui.mount({
        plugin: 'progress-bars',
        surface,
        component: 'ToolResult',
        requestId: id,
        props: { tool_use_id: id, tool: use.tool ?? 'Bash', output: use.output, isErrored: use.isErrored ?? false, isExpanded: use.isExpanded },
      } as never)
      expect((await result.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
      await result.unmount()
    }

    test('an expanded row', async ($, on) => {
      engine(on)
      const { id } = await timedCall($, on, 14_000)
      await keeps($, id, { isExpanded: true })
    })

    test('a desktop surface', async ($, on) => {
      engine(on)
      const { id } = await timedCall($, on, 14_000)
      await keeps($, id, {}, 'desktop')
    })

    for (const tool of KEEP_TOOLS) {
      test(`the ${tool} tool`, async ($, on) => {
        engine(on)
        const { id } = await timedCall($, on, 14_000, tool)
        await keeps($, id, { tool })
      })
    }

    test('an errored call whose output is a refusal', async ($, on) => {
      engine(on)
      const { id } = await timedCall($, on, 14_000)
      await keeps($, id, { isErrored: true, output: `${REFUSED_PREFIX}: the command was declined.` })
    })

    test('an id with no recorded time', async ($, on) => {
      engine(on)
      await keeps($, 'toolu_never_called', {})
    })
  })
})

describe('the ticker', () => {
  test('a running bar grows by the ticker alone', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const seen: { id?: string } = {}
    const wrote = writes(on)
    bash(on, clock, seen)

    engine(on)
    const call = $.tool.call({ tool: 'Bash', command: 'make test' })
    await clock.advance(1_000)
    const ui = await mountUse($, seen.id as string, { isRunning: true })
    expect((await readBar(ui)).time).toBe('1s')

    await clock.advance(1_000)
    expect((await readBar(ui)).time).toBe('2s')
    await clock.advance(12_000)
    await call

    const after = wrote.length
    await clock.advance(1_000)
    expect(wrote.length).toBe(after)
    await ui.unmount()
  })
})
