import { describe, expect, mock, test } from 'claude-code/testing'
import type { ModelForkResult, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { fitTables } from '../hooks/tables'
import { buildAsk } from '../hooks/thread'

const PANE = {
  plugin: 'aside',
  component: 'Pane',
  requestId: 'aside',
  props: {
    title: 'Aside',
    isFocused: true,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

function answered(text: string): ModelForkResult {
  return { isAnswered: true, text, usage: USAGE }
}

// Stands for the engine: a model that answers each fork with `replies` in
// turn, a prompt box holding `box.text`, and a record of what was asked,
// opened, filled and toasted.
function engine(on: On, replies: ModelForkResult[], box = { text: '' }) {
  const seen = { asks: [] as string[], opens: [] as unknown[], fills: [] as unknown[], toasts: [] as string[] }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', (_, e) => {
    seen.fills.push({ text: e.text, mode: e.mode })
    box.text = e.mode === 'append' ? box.text + e.text : e.text

    return { isFilled: true }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', (_, e) => {
    seen.opens.push(e)

    return { value: { isPlaced: true } }
  })
  on('ui.scroll', () => ({}))
  on('ui.toast', (_, e) => {
    seen.toasts.push(String(e.text))

    return { value: undefined }
  })
  on('model.fork', (_, e) => {
    seen.asks.push(e.prompt)

    return { value: replies.shift() ?? answered('(none left)') }
  })

  return seen
}

async function start($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

async function aside($: Engine, args: string, command = 'aside') {
  return $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

describe('/aside', () => {
  test('opens the pane and answers the question there', async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on, [answered('The fixture path was **absolute**.')])
    await start($)

    const ran = await aside($, 'why did the test fail?')
    await clock.advance(1)

    expect(ran.text).toBeUndefined()
    expect(seen.opens).toEqual([expect.objectContaining({ id: 'aside', focus: true })])
    expect(seen.asks[0]).toContain('<question>\nwhy did the test fail?\n</question>')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /why did the test fail/ }))?.type).toBe('Text')
    expect((await ui.find({ type: 'Markdown' }))?.text).toBe('The fixture path was **absolute**.')
    await ui.unmount()
  })

  test('with no question, only opens the pane', async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on, [])
    await start($)

    await aside($, '')
    await clock.advance(1)

    expect(seen.opens).toHaveLength(1)
    expect(seen.asks).toHaveLength(0)
  })
})

describe('the pane', () => {
  test('a follow-up carries the thread so far', async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on, [answered('Because of X.'), answered('In tests/fix.rs.')])
    await start($)

    await aside($, 'why?')
    await clock.advance(1)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'ask', text: 'which file?' })
    await clock.advance(1)

    expect(seen.asks[1]).toContain('<question>\nwhy?\n</question>\n<answer>\nBecause of X.\n</answer>')
    expect(seen.asks[1]).toContain('<question>\nwhich file?\n</question>')
    expect((await ui.findAll({ type: 'Markdown' })).map(found => found.text)).toEqual([
      'Because of X.',
      'In tests/fix.rs.',
    ])
    await ui.unmount()
  })

  test('New thread starts over', async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on, [answered('One.'), answered('Two.')])
    await start($)

    await aside($, 'first?')
    await clock.advance(1)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'new' })
    await ui.input({ key: 'ask', text: 'second?' })
    await clock.advance(1)

    expect(seen.asks[1]).not.toContain('first?')
    expect((await ui.findAll({ type: 'Markdown' })).map(found => found.text)).toEqual(['Two.'])
    await ui.unmount()
  })

  test('says why when no answer came', async ($, on) => {
    const clock = mock.clock(on)
    engine(on, [{ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }])
    await start($)

    await aside($, 'why?')
    await clock.advance(1)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /529/ }))?.text).toContain('overloaded')
    await ui.unmount()
  })

  test('before the first turn, answers without the conversation', async ($, on) => {
    const clock = mock.clock(on)
    engine(on, [{ isAnswered: false, reason: 'nothing-to-fork' }])
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('model.complete', () => ({ value: { isAnswered: true, text: 'From general knowledge: yes.', usage: USAGE } }))
    await start($)

    await aside($, 'is this ok?')
    await clock.advance(1)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Markdown' }))?.text).toBe('From general knowledge: yes.')
    await ui.unmount()
  })

  test('draws the thread on every surface, a field where the surface has one', async ($, on) => {
    const clock = mock.clock(on)
    engine(on, [answered('Yes.')])
    await start($)
    await aside($, 'ok?')
    await clock.advance(1)

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Markdown' }))?.text).toBe('Yes.')
      // Claude Code 2.1.318's test kit gives mobile an Input too, though its
      // types say the app draws no field yet: the pane draws one wherever the
      // surface's table has it, so mobile is left to the table.
      if (surface !== 'mobile') {
        expect((await ui.find({ key: 'ask' }))?.type).toBe('Input')
      }
      await ui.unmount()
    }
  })
})

describe('hand off', () => {
  const FOUND = 'Because the cache key leaves out the locale.'
  const REQUEST = 'Key the cache by locale in src/cache.ts, then rerun the i18n tests.'

  test('Hand off writes a request from the thread into the prompt box', async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on, [answered(FOUND), answered(REQUEST)])
    await start($)

    await aside($, 'why is the page stale?')
    await clock.advance(1)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'handoff' })
    await clock.advance(1)

    expect(seen.asks[1]).toContain('<question>\nwhy is the page stale?\n</question>\n<answer>\n' + FOUND + '\n</answer>')
    expect(seen.asks[1]).toContain('Write the message they will send you')
    expect(seen.fills).toEqual([{ text: REQUEST, mode: 'replace' }])
    expect(seen.toasts).toEqual(['The hand-off is in the prompt box. Edit it, then press Enter.'])
    await ui.unmount()
  })

  test('adds the request after a draft already in the box', async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on, [answered(FOUND), answered(REQUEST)], { text: 'and run the linter' })
    await start($)

    await aside($, 'why?')
    await clock.advance(1)
    await aside($, '', 'aside-handoff')
    await clock.advance(1)

    expect(seen.fills).toEqual([{ text: '\n\n' + REQUEST, mode: 'append' }])
  })

  test('/aside-handoff passes its text on as what to ask for', async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on, [answered(FOUND), answered(REQUEST)])
    await start($)

    await aside($, 'why?')
    await clock.advance(1)
    const ran = await aside($, 'fix it, skip the tests', 'aside-handoff')
    await clock.advance(1)

    expect(ran.text).toBeUndefined()
    expect(seen.asks[1]).toContain('What the user wants done with it:\n\nfix it, skip the tests')
    expect(seen.fills).toEqual([{ text: REQUEST, mode: 'replace' }])
  })

  test('with no answer yet, has nothing to hand off', async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on, [])
    await start($)

    await aside($, '', 'aside-handoff')
    await clock.advance(1)

    expect(seen.asks).toHaveLength(0)
    expect(seen.toasts).toEqual(['Nothing to hand off yet: no side question has an answer.'])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'handoff' })).toBeUndefined()
    await ui.unmount()
  })

  test('says why when the request could not be written, and leaves the box alone', async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on, [answered(FOUND), { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }])
    await start($)

    await aside($, 'why?')
    await clock.advance(1)
    await aside($, '', 'aside-handoff')
    await clock.advance(1)

    expect(seen.fills).toHaveLength(0)
    expect(seen.toasts).toEqual(["Couldn't write the hand-off: the API answered 529 (overloaded)."])
  })
})

// 109 cells wide as the terminal draws it: wider than any docked pane.
const WIDE = [
  'Here is the comparison:',
  '',
  '| Terminal | GPU rendering | Image protocol | Notes |',
  '| --- | --- | --- | --- |',
  '| Ghostty | Yes, Metal on macOS and OpenGL on Linux | Kitty graphics protocol | Fast startup, native tabs |',
  '| iTerm2 | Optional, Metal renderer | iTerm2 inline images | Mature, heavier on memory |',
  '',
  'Pick Ghostty.',
].join('\n')

const WIDE_AS_LIST = [
  'Here is the comparison:',
  '',
  '**Ghostty**',
  '- GPU rendering: Yes, Metal on macOS and OpenGL on Linux',
  '- Image protocol: Kitty graphics protocol',
  '- Notes: Fast startup, native tabs',
  '',
  '**iTerm2**',
  '- GPU rendering: Optional, Metal renderer',
  '- Image protocol: iTerm2 inline images',
  '- Notes: Mature, heavier on memory',
  '',
  'Pick Ghostty.',
].join('\n')

const NARROW = ['| Key | Value |', '| --- | --- |', '| a | 1 |'].join('\n')

describe('tables', () => {
  // The terminal lays a table out for the whole terminal, so one wider than
  // a docked pane had each of its rows wrapped at the pane's edge.
  test('a table wider than the docked pane comes as one block per row', async ($, on) => {
    const clock = mock.clock(on)
    engine(on, [answered(WIDE), answered(NARROW)])
    await start($)

    await aside($, 'compare?')
    await clock.advance(1)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'ask', text: 'short?' })
    await clock.advance(1)

    expect((await ui.findAll({ type: 'Markdown' })).map(found => found.text)).toEqual([WIDE_AS_LIST, NARROW])
    await ui.unmount()
  })

  test('stays a table where the pane spans the terminal, or off the terminal', async ($, on) => {
    const clock = mock.clock(on)
    engine(on, [answered(WIDE)])
    await start($)
    await aside($, 'compare?')
    await clock.advance(1)

    const inline = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'inline' }, surface: 'terminal' })
    expect((await inline.find({ type: 'Markdown' }))?.text).toBe(WIDE)
    await inline.unmount()

    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await desktop.find({ type: 'Markdown' }))?.text).toBe(WIDE)
    await desktop.unmount()
  })

  test('counts a wide character as two cells', () => {
    // 53 cells wide: 14 for the first column, 36 for the second, 3 rules.
    const table = ['| ファイル | 説明 |', '| --- | --- |', '| register.tsx | フック：コマンド、ペイン、タイマー |'].join('\n')

    expect(fitTables(table, 53)).toBe(table)
    expect(fitTables(table, 52)).toBe('**register.tsx**\n- 説明: フック：コマンド、ペイン、タイマー')
  })

  test('leaves a table in a code fence alone, and keeps an escaped pipe in its cell', () => {
    const fenced = ['```', WIDE, '```'].join('\n')
    const piped = ['| Name | Use |', '| --- | --- |', '| or | a \\| b |'].join('\n')

    expect(fitTables(fenced, 20)).toBe(fenced)
    expect(fitTables(piped, 10)).toBe('**or**\n- Use: a \\| b')
  })
})

describe('the ask', () => {
  test('leaves out questions that got no answer', () => {
    const ask = buildAsk(
      [
        { id: '1', question: 'a?', answer: 'A.' },
        { id: '2', question: 'b?', error: 'No answer.' },
      ],
      'c?',
    )

    expect(ask).toContain('a?')
    expect(ask).not.toContain('b?')
    expect(ask.endsWith('<question>\nc?\n</question>')).toBe(true)
  })
})
