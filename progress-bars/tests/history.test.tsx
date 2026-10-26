import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { barCells } from '../hooks/scale'
import { callTimesFrom, parseEntries } from '../hooks/history'
import { engine, readBar } from './helpers'

const T0 = 1_800_000_000_000

function iso(ms: number) {
  return new Date(ms).toISOString()
}

// One line of a session file, in the key order the real file uses.
function toolUseLine(id: string, at: number) {
  return JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] },
    type: 'assistant',
    uuid: `u-${id}`,
    timestamp: iso(at),
  })
}

function toolResultLine(id: string, at: number) {
  return JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    type: 'user',
    uuid: `r-${id}`,
    timestamp: iso(at),
  })
}

// What `find` and `grep` answer. Each run is an exit code and its stdout;
// `throws` makes every process call fail.
type Answers = { find?: string; grepExit?: number; lines?: string | (() => string); throws?: boolean }

function answerProcesses(on: On, answers: Answers) {
  on('process.run', (_, e) => {
    if (answers.throws) {
      throw new Error('cannot start')
    }
    const isFind = e.argv[0] === 'find'
    const exitCode = isFind ? 0 : (answers.grepExit ?? 0)
    const lines = typeof answers.lines === 'function' ? answers.lines() : answers.lines
    const stdout = isFind ? (answers.find ?? '') : (lines ?? '')

    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

function sessionOn(on: On, session: string) {
  on('session.id', () => ({ value: session }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
}

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

async function mountUse($: Engine, id: string, props: Record<string, unknown> = {}) {
  return $.ui.mount({
    plugin: 'progress-bars',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: `history-${id}`,
    props: useProps(id, props),
  } as never)
}

describe('session file lines', () => {
  test('parseEntries skips a cut last line', () => {
    const stdout = `${toolUseLine('toolu_cut', T0)}\n${toolResultLine('toolu_cut', T0 + 1)}\n{"type":"us`

    expect(parseEntries(stdout)).toHaveLength(2)
  })

  test('callTimesFrom reads starts and ends', () => {
    const lines = [
      '{"parentUuid":"p","isSidechain":false,"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_A","name":"Bash","input":{}}]},"type":"assistant","uuid":"a1","timestamp":"2026-10-26T10:42:28.252Z"}',
      '{"parentUuid":"p","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_A","content":"ok"}]},"type":"user","uuid":"u1","timestamp":"2026-10-26T10:42:30.554Z"}',
    ].join('\n')
    const times = callTimesFrom(parseEntries(lines))

    expect(times.get('toolu_A')).toEqual({ start: Date.parse('2026-10-26T10:42:28.252Z'), end: Date.parse('2026-10-26T10:42:30.554Z') })
    expect(times.get('toolu_A')?.end! - times.get('toolu_A')?.start!).toBe(2302)
  })
})

// A call that starts, then loses its end as a reload would: the state keeps
// only the start. Returns the call's id.
async function startedThenLost($: Engine, on: On, clock: { sleep: (ms: number) => Promise<void>; advance: (ms: number) => Promise<void> }, ms: number) {
  const seen: { id?: string } = {}
  let calls = 0
  on('state.set', (_, e, next) => {
    if (e.key !== 'calls') {
      return next(e)
    }

    return ++calls === 1 ? next(e) : { deny: 'lost' }
  })
  on('tool.call', { tool: 'Bash' }, async (_, e) => {
    seen.id = e.tool_use_id
    await clock.sleep(ms)

    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  const call = $.tool.call({ tool: 'Bash', command: 'make test' })
  await clock.advance(ms)
  await call

  return seen.id as string
}

describe('a call with no recorded time', () => {
  test("a resumed session's call shows its saved time", async ($, on) => {
    mock.clock(on, { now: T0 })
    sessionOn(on, 'S-resume-1')
    answerProcesses(on, {
      find: '/home/u/.claude/projects/p/S-resume-1.jsonl\n',
      lines: `${toolUseLine('toolu_resume_A', T0)}\n${toolResultLine('toolu_resume_A', T0 + 2302)}\n`,
    })

    const ui = await mountUse($, 'toolu_resume_A')
    expect(await readBar(ui)).toEqual({ glyphs: barCells(2302), color: 'success', time: '2s' })
    await ui.unmount()
  })

  test('the ToolUse row stops growing after a reload lost its end', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    sessionOn(on, 'S-reload-1')
    let id = ''
    answerProcesses(on, {
      find: '/home/u/.claude/projects/p/S-reload-1.jsonl\n',
      lines: () => `${toolUseLine(id, T0)}\n${toolResultLine(id, T0 + 5000)}\n`,
    })
    id = await startedThenLost($, on, clock, 5_000)

    const ui = await mountUse($, id)
    expect(await readBar(ui)).toEqual({ glyphs: barCells(5000), color: 'success', time: '5s' })
    await clock.advance(60_000)
    await ui.redraw()
    expect(await readBar(ui)).toEqual({ glyphs: barCells(5000), color: 'success', time: '5s' })
    await ui.unmount()
  })

  test('the stopped row keeps the engine drawing when history has no end', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-reload-2')
    let id = ''
    answerProcesses(on, { find: '/home/u/.claude/projects/p/S-reload-2.jsonl\n', lines: () => `${toolUseLine(id, T0)}\n` })
    id = await startedThenLost($, on, clock, 5_000)

    const ui = await mountUse($, id)
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('no session file keeps the engine drawing, with no error', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-missing-1')
    answerProcesses(on, { find: '' })

    const ui = await mountUse($, 'toolu_missing_A')
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('a grep that exits 2 keeps the engine drawing, with no error', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-grep-2')
    answerProcesses(on, { find: '/home/u/.claude/projects/p/S-grep-2.jsonl\n', grepExit: 2 })

    const ui = await mountUse($, 'toolu_grep_A')
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('a process that throws keeps the engine drawing, with no error', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-throw-1')
    answerProcesses(on, { throws: true })

    const ui = await mountUse($, 'toolu_throw_A')
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })
})
