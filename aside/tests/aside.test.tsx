import { describe, expect, mock, test } from 'claude-code/testing'
import type { ModelForkResult, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

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
// turn, and a record of what was asked, opened and toasted.
function engine(on: On, replies: ModelForkResult[]) {
  const seen = { asks: [] as string[], opens: [] as unknown[], toasts: [] as string[] }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
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

async function aside($: Engine, args: string) {
  return $.command.run({
    command: 'aside',
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
      expect((await ui.find({ key: 'ask' })) === undefined).toBe(surface === 'mobile')
      await ui.unmount()
    }
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
