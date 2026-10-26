import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, StateWrite } from 'claude-code'

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

// Records every write the mod makes to state, and accepts it.
function writes(on: On) {
  const seen: StateWrite[] = []
  on('state.set', (_, e) => {
    seen.push(e)

    return { value: { isSet: true, version: 1 } }
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
    let writesSeen = 0
    on('state.set', () => (++writesSeen === 1 ? { value: { isSet: true, version: 1 } } : { deny: 'refused' }))
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
