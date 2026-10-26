import { describe, expect, test } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

const TEXT = 'Use no tools. Reply with one word: hi'

function row(origin: PromptOrigin) {
  return {
    plugin: 'prompt-style',
    component: 'UserMessage',
    props: { text: TEXT, origin, isExpanded: false },
  } as const
}

// What the engine draws for the row when the plugin passes.
function engine(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

describe('your own prompt on the terminal', () => {
  for (const origin of [{ kind: 'composer' }, { kind: 'bridge' }] as const) {
    test(`sits beside an orange bar, with no band behind it (${origin.kind})`, async ($, on) => {
      engine(on)

      const ui = await $.ui.mount({ ...row(origin), surface: 'terminal' })
      const boxes = await ui.findAll({ type: 'Box' })
      const texts = await ui.findAll({ type: 'Text' })

      expect(texts.map(t => [t.text, t.props.backgroundColor])).toEqual([[TEXT, undefined]])
      expect(boxes.filter(b => b.props.backgroundColor !== undefined).map(b => b.props)).toEqual([
        { width: 1, backgroundColor: 'claude' },
      ])
      await ui.unmount()
    })
  }

  test('keeps the blank line above it', async ($, on) => {
    engine(on)

    const ui = await $.ui.mount({ ...row({ kind: 'composer' }), surface: 'terminal' })
    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { marginTop: 1 } })
    await ui.unmount()
  })
})

describe('everything else', () => {
  const others: PromptOrigin[] = [
    { kind: 'task-notification' },
    { kind: 'peer' },
    { kind: 'channel', server: 'slack' },
    { kind: 'plugin', name: 'prompt-enhancer', asUser: true },
    { kind: 'unclassified' },
  ]

  for (const origin of others) {
    test(`keeps the engine's drawing of a row from ${origin.kind}`, async ($, on) => {
      engine(on)

      const ui = await $.ui.mount({ ...row(origin), surface: 'terminal' })
      expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
      await ui.unmount()
    })
  }

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    test(`keeps the ${surface} app's own drawing of your prompt`, async ($, on) => {
      engine(on)

      const ui = await $.ui.mount({ ...row({ kind: 'composer' }), surface })
      expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
      await ui.unmount()
    })
  }
})
