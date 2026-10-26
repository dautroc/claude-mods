import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { barCells } from '../hooks/scale'
import { INDEX_PATTERN, parseIndex, type SessionIndex } from '../hooks/history'
import {
  REAL_GREP_OUTPUT,
  REAL_LINES,
  answerProcesses,
  byteLength,
  engine,
  indexOutput,
  readBar,
  sessionOn,
  toolResultLine,
  toolUseLine,
} from './helpers'

const T0 = 1_800_000_000_000

function emptyIndex(): SessionIndex {
  return { calls: new Map(), turns: new Map(), handbacks: new Set() }
}

const REAL_FILE = `${REAL_LINES.join('\n')}\n`
const at = (iso: string) => Date.parse(iso)

describe('the index from grep output', () => {
  test('the stand-in prints exactly what the real grep printed', () => {
    expect(INDEX_PATTERN).toContain('toolu_')
    expect(indexOutput(REAL_FILE)).toBe(REAL_GREP_OUTPUT)
  })

  test('the stand-in counts from the byte it starts at, as tail does', () => {
    const second = byteLength(`${REAL_LINES[0]}\n`)

    expect(indexOutput(REAL_FILE, second)).toBe(
      REAL_GREP_OUTPUT.split('\n')
        .filter(row => Number(row.split(':')[0]) >= 2)
        .map(row => {
          const [line, byte, ...rest] = row.split(':')

          return `${Number(line) - 1}:${Number(byte) - second}:${rest.join(':')}`
        })
        .join('\n') + '\n',
    )
  })

  test('parseIndex reads calls, turns and hand-backs, and skips quoted ids', () => {
    const index = emptyIndex()
    const next = parseIndex(REAL_GREP_OUTPUT, 0, index)

    expect(index.calls.get('toolu_AAA')).toEqual({ start: at('2026-10-26T10:00:00.000Z'), end: at('2026-10-26T10:00:02.500Z'), name: 'Bash' })
    expect(index.calls.get('toolu_BBB')).toEqual({ start: at('2026-10-26T10:00:00.000Z'), end: at('2026-10-26T10:00:02.500Z'), name: 'Agent' })
    expect(index.calls.has('toolu_X')).toBe(false)
    expect(index.calls.has('toolu_Y')).toBe(false)
    expect(index.turns.get('33333333-3333-3333-3333-333333333333')).toEqual({ at: at('2026-10-26T10:00:05.000Z'), pending: 1 })
    expect(index.turns.get('44444444-4444-4444-4444-444444444444')).toEqual({ at: at('2026-10-26T10:00:20.000Z'), pending: 0 })
    expect([...index.handbacks]).toEqual(['55555555-5555-5555-5555-555555555555'])
    expect(next).toBe(1418)
  })

  test('parseIndex adds the base to the offset it returns', () => {
    expect(parseIndex(REAL_GREP_OUTPUT, 5_000, emptyIndex())).toBe(6_418)
  })

  test('a line cut before its timestamp is skipped, with no offset', () => {
    const index = emptyIndex()

    expect(parseIndex('1:10:"id":"toolu_CUT","name":"Bash"\n1:90:"tool_use_id":"toolu_CUT"\n', 0, index)).toBeUndefined()
    expect(index.calls.size).toBe(0)
  })

  test('a call keeps the first start and end it was given', () => {
    const index = emptyIndex()
    const line = (t: string) => `1:1:"id":"toolu_K","name":"Bash"\n1:20:"tool_use_id":"toolu_K"\n1:40:"uuid":"${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}","timestamp":"${t}"\n`
    parseIndex(line('2026-10-26T10:00:00.000Z'), 0, index)
    parseIndex(line('2026-10-26T10:05:00.000Z'), 0, index)

    expect(index.calls.get('toolu_K')).toEqual({ start: at('2026-10-26T10:00:00.000Z'), end: at('2026-10-26T10:00:00.000Z'), name: 'Bash' })
  })

  test('rows that do not fit line:byte:match are skipped', () => {
    const index = emptyIndex()

    expect(parseIndex('Binary file x matches\nnot:a:row\n', 0, index)).toBeUndefined()
    expect(index.calls.size + index.turns.size + index.handbacks.size).toBe(0)
  })
})

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
    answerProcesses(on, 'S-resume-1', { text: `${toolUseLine('toolu_resume_A', 'Bash', T0)}\n${toolResultLine('toolu_resume_A', T0 + 2302)}\n` })

    const ui = await mountUse($, 'toolu_resume_A')
    expect(await readBar(ui)).toEqual({ glyphs: barCells(2302), color: 'success', time: '2s' })
    await ui.unmount()
  })

  test('the ToolUse row stops growing after a reload lost its end', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    sessionOn(on, 'S-reload-1')
    let id = ''
    answerProcesses(on, 'S-reload-1', { text: () => `${toolUseLine(id, 'Bash', T0)}\n${toolResultLine(id, T0 + 5000)}\n` })
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
    answerProcesses(on, 'S-reload-2', { text: () => `${toolUseLine(id, 'Bash', T0)}\n` })
    id = await startedThenLost($, on, clock, 5_000)

    const ui = await mountUse($, id)
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('no session file keeps the engine drawing, with no error', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-missing-1')
    answerProcesses(on, 'S-missing-1', { find: '' })

    const ui = await mountUse($, 'toolu_missing_A')
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('a grep that exits 2 keeps the engine drawing, with no error', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-grep-2')
    answerProcesses(on, 'S-grep-2', { rg: 2, grepExit: 2 })

    const ui = await mountUse($, 'toolu_grep_A')
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('a process that throws keeps the engine drawing, with no error', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-throw-1')
    answerProcesses(on, 'S-throw-1', { throws: true })

    const ui = await mountUse($, 'toolu_throw_A')
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('CLAUDE_CONFIG_DIR says where the session file is searched', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    on('session.id', () => ({ value: 'S-config-1' }))
    on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/cfg' : undefined }))
    const ran = answerProcesses(on, 'S-config-1', { text: `${toolUseLine('toolu_cfg_A', 'Bash', T0)}\n${toolResultLine('toolu_cfg_A', T0 + 1000)}\n` })

    const ui = await mountUse($, 'toolu_cfg_A')
    expect(ran[0]).toEqual(['find', '/cfg/projects', '-maxdepth', '2', '-name', 'S-config-1.jsonl'])
    expect(await readBar(ui)).toEqual({ glyphs: barCells(1000), color: 'success', time: '1s' })
    await ui.unmount()
  })
})

describe('a row drawn before its call starts', () => {
  test('a running ToolUse with no start in state keeps the engine drawing and runs no process', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-early-use')
    const ran = answerProcesses(on, 'S-early-use', { text: `${toolUseLine('toolu_early_use', 'Bash', T0)}\n` })

    const ui = await mountUse($, 'toolu_early_use', { isRunning: true })
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    expect(ran).toEqual([])
    await ui.unmount()
  })
})

describe('the scans', () => {
  test('ripgrep answers the first scan, in one pass over the whole file', async ($, on) => {
    mock.clock(on, { now: T0 })
    sessionOn(on, 'S-rg-1')
    const ran = answerProcesses(on, 'S-rg-1', { text: `${toolUseLine('toolu_rg_A', 'Bash', T0)}\n${toolResultLine('toolu_rg_A', T0 + 2000)}\n` })

    const ui = await mountUse($, 'toolu_rg_A')
    expect(await readBar(ui)).toEqual({ glyphs: barCells(2000), color: 'success', time: '2s' })
    await ui.unmount()

    expect(ran.slice(1)).toEqual([['rg', '--no-config', '-a', '-n', '-b', '-o', '-e', INDEX_PATTERN, '/home/u/.claude/projects/p/S-rg-1.jsonl']])
  })

  for (const rg of ['throws', 2] as const) {
    test(`ripgrep ${rg === 'throws' ? 'throwing' : 'exiting 2'} falls back to grep`, async ($, on) => {
      mock.clock(on, { now: T0 })
      sessionOn(on, `S-rg-${rg}`)
      const ran = answerProcesses(on, `S-rg-${rg}`, { rg, text: `${toolUseLine(`toolu_fb_${rg}`, 'Bash', T0)}\n${toolResultLine(`toolu_fb_${rg}`, T0 + 3000)}\n` })

      const ui = await mountUse($, `toolu_fb_${rg}`)
      expect(await readBar(ui)).toEqual({ glyphs: barCells(3000), color: 'success', time: '3s' })
      await ui.unmount()

      expect(ran.map(argv => argv[0])).toEqual(['find', 'rg', 'grep'])
      expect(ran[2]).toEqual(['grep', '-a', '-n', '-b', '-o', '-E', INDEX_PATTERN, `/home/u/.claude/projects/p/S-rg-${rg}.jsonl`])
    })
  }

  test('a lookup that misses again inside 1 s runs no scan; after 1 s one scan reads from the stored offset', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-throttle')
    const first = toolUseLine('toolu_th_A', 'Bash', T0)
    let text = `${first}\n`
    const ran = answerProcesses(on, 'S-throttle', { text: () => text })

    const one = await mountUse($, 'toolu_th_A')
    await one.unmount()
    const scans = () => ran.filter(argv => argv[0] === 'rg' || argv[0] === 'sh')
    expect(scans()).toHaveLength(1)

    text += `${toolResultLine('toolu_th_A', T0 + 2302)}\n`
    await clock.advance(500)
    const two = await mountUse($, 'toolu_th_A')
    expect((await two.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await two.unmount()
    expect(scans()).toHaveLength(1)

    await clock.advance(600)
    const three = await mountUse($, 'toolu_th_A')
    expect(await readBar(three)).toEqual({ glyphs: barCells(2302), color: 'success', time: '2s' })
    await three.unmount()

    const offset = byteLength(first.slice(0, first.indexOf('"uuid"')))
    expect(scans()).toHaveLength(2)
    expect(scans()[1]).toEqual([
      'sh',
      '-c',
      'tail -c +"$1" "$2" | grep -a -n -b -o -E "$3"',
      'sh',
      String(offset + 1),
      '/home/u/.claude/projects/p/S-throttle.jsonl',
      INDEX_PATTERN,
    ])
  })

  test('two rows mounted together run one scan between them', async ($, on) => {
    mock.clock(on, { now: T0 })
    sessionOn(on, 'S-together')
    const ran = answerProcesses(on, 'S-together', {
      text: [
        toolUseLine('toolu_tg_A', 'Bash', T0),
        toolResultLine('toolu_tg_A', T0 + 1000),
        toolUseLine('toolu_tg_B', 'Bash', T0),
        toolResultLine('toolu_tg_B', T0 + 4000),
        '',
      ].join('\n'),
    })

    const [a, b] = await Promise.all([mountUse($, 'toolu_tg_A'), mountUse($, 'toolu_tg_B')])
    expect((await readBar(a)).time).toBe('1s')
    expect((await readBar(b)).time).toBe('4s')
    await a.unmount()
    await b.unmount()

    expect(ran.filter(argv => argv[0] === 'rg')).toHaveLength(1)
  })

  test('a truncated output drops its last line', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-trunc')
    const text = [
      toolUseLine('toolu_tr_A', 'Bash', T0),
      toolResultLine('toolu_tr_A', T0 + 1000),
      toolUseLine('toolu_tr_B', 'Bash', T0),
      toolResultLine('toolu_tr_B', T0 + 4000),
      '',
    ].join('\n')
    // The output is cut after its last whole line, so only the dropped line tells.
    answerProcesses(on, 'S-trunc', { text, cutAt: indexOutput(text).length - 1 })

    const a = await mountUse($, 'toolu_tr_A')
    expect((await readBar(a)).time).toBe('1s')
    await a.unmount()
    const b = await mountUse($, 'toolu_tr_B')
    expect((await b.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await b.unmount()
  })
})

describe('the session file search is remembered for 10 s', () => {
  test('a find that finds nothing is asked once inside 10 s', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-miss-c')
    const ran = answerProcesses(on, 'S-miss-c', { find: '' })

    const first = await mountUse($, 'toolu_miss_C1')
    await first.unmount()
    const second = await mountUse($, 'toolu_miss_C2')
    await second.unmount()

    expect(ran.filter(argv => argv[0] === 'find')).toHaveLength(1)
    expect(ran.filter(argv => argv[0] !== 'find')).toHaveLength(0)
  })
})
