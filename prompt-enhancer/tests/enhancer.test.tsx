import { describe, expect, test } from 'claude-code/testing'
import type { ModelForkResult, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { extractPrompt, instructionPaths } from '../hooks/enhance'

const BAND = {
  plugin: 'prompt-enhancer',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const NEVER: ModelForkResult = { isAnswered: false, reason: 'nothing-to-fork' }
const ANSWER = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// Stands for the engine: a prompt box holding `box.text`, a model that
// answers `reply`, and a record of every fill, submit and toast.
function engine(on: On, box: { text: string }, reply: () => ModelForkResult) {
  const seen = { fills: [] as string[], submits: [] as unknown[], toasts: [] as string[], asks: [] as unknown[] }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // What the engine draws in the band when the plugin passes.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', (_, e) => {
    seen.fills.push(e.text)
    box.text = e.text

    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    seen.submits.push({ text: e.text, origin: e.origin })

    return { text: e.text }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(String(e.text))

    return { value: undefined }
  })
  on('model.fork', (_, e) => {
    seen.asks.push(e)

    return { value: reply() }
  })

  return seen
}

async function start($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

describe('the band', () => {
  test('stays out of the way with an empty box', async ($, on) => {
    engine(on, { text: '' }, () => NEVER)
    await start($)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ key: 'enhance' })).toBeUndefined()
    await ui.unmount()
  })

  test('offers Enhance for a draft, on every surface that draws it', async ($, on) => {
    engine(on, { text: 'fix it' }, () => NEVER)
    await start($)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect((await ui.find({ key: 'enhance' }))?.type).toBe('Button')
      await ui.unmount()
    }
  })

  test('leaves slash commands alone', async ($, on) => {
    engine(on, { text: '/compact' }, () => NEVER)
    await start($)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ key: 'enhance' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('enhancing', () => {
  test('replaces the draft with the rewritten prompt, then offers Send and Undo', async ($, on) => {
    const box = { text: 'fix it' }
    const seen = engine(on, box, () => ({
      isAnswered: true,
      text: '<prompt>Fix the failing login test in src/auth.test.ts.</prompt>',
      usage: ANSWER,
    }))
    await start($)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'enhance' })

    expect(seen.asks).toHaveLength(1)
    expect(JSON.stringify(seen.asks[0])).toContain('<draft>\\nfix it\\n</draft>')
    expect(box.text).toBe('Fix the failing login test in src/auth.test.ts.')
    expect((await ui.find({ key: 'send' }))?.type).toBe('Button')
    expect((await ui.find({ key: 'undo' }))?.type).toBe('Button')
    await ui.unmount()
  })

  test('Send submits what the box holds and empties it', async ($, on) => {
    const box = { text: 'fix it' }
    const seen = engine(on, box, () => ({ isAnswered: true, text: '<prompt>Fix it well.</prompt>', usage: ANSWER }))
    await start($)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'enhance' })
    box.text = 'Fix it well, please.'
    await ui.press({ key: 'send' })

    expect(box.text).toBe('')
    expect(seen.submits).toEqual([
      { text: 'Fix it well, please.', origin: expect.objectContaining({ kind: 'plugin', asUser: true }) },
    ])
    await ui.unmount()
  })

  test('Undo puts the draft back', async ($, on) => {
    const box = { text: 'fix it' }
    engine(on, box, () => ({ isAnswered: true, text: '<prompt>Fix it well.</prompt>', usage: ANSWER }))
    await start($)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'enhance' })
    await ui.press({ key: 'undo' })

    expect(box.text).toBe('fix it')
    expect((await ui.find({ key: 'enhance' }))?.type).toBe('Button')
    await ui.unmount()
  })

  test('keeps a draft the person changed while the model worked', async ($, on) => {
    const box = { text: 'fix it' }
    const seen = engine(on, box, () => {
      box.text = 'fix it now'

      return { isAnswered: true, text: '<prompt>Fix it.</prompt>', usage: ANSWER }
    })
    await start($)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'enhance' })

    expect(box.text).toBe('fix it now')
    expect(seen.toasts.join()).toContain('changed')
    await ui.unmount()
  })

  test('says why when the model gives no prompt', async ($, on) => {
    const box = { text: 'fix it' }
    const seen = engine(on, box, () => ({
      isAnswered: false,
      reason: 'api-error',
      status: 529,
      error: 'overloaded',
      usage: ANSWER,
    }))
    await start($)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'enhance' })

    expect(box.text).toBe('fix it')
    expect(seen.toasts.join()).toContain('529')
    expect((await ui.find({ key: 'enhance' }))?.type).toBe('Button')
    await ui.unmount()
  })

  test('before the first turn, sends the project instructions and skills itself', async ($, on) => {
    const box = { text: 'fix it' }
    engine(on, box, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
    const systems: string[] = []
    on('session.root', () => ({ value: '/work/app' }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('env.get', () => ({ value: '/home/me' }))
    on('fs.read', (_, e) =>
      e.path === '/work/app/AGENTS.md' ? { value: 'Run make test before you finish.' } : { deny: 'missing' },
    )
    on('command.list', () => ({
      value: [
        { name: 'ship', description: 'Commit, push or release', source: 'user' },
        { name: 'compact', description: 'Compact the chat', source: 'builtin' },
      ],
    }))
    on('model.complete', (_, e) => {
      systems.push(String(e.system))

      return { value: { isAnswered: true, text: '<prompt>Fix it, then run make test.</prompt>', usage: ANSWER } }
    })
    await start($)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'enhance' })

    expect(box.text).toBe('Fix it, then run make test.')
    expect(systems[0]).toContain('Run make test before you finish.')
    expect(systems[0]).toContain('/ship: Commit, push or release')
    expect(systems[0]).not.toContain('/compact')
    await ui.unmount()
  })
})

describe('/enhance', () => {
  test('rewrites its argument into the box', async ($, on) => {
    const box = { text: '' }
    engine(on, box, () => ({ isAnswered: true, text: '<prompt>Fix the login bug.</prompt>', usage: ANSWER }))
    await start($)

    const ran = await $.command.run({
      command: 'enhance',
      args: 'fix login',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })

    expect(box.text).toBe('Fix the login bug.')
    expect(ran.text).toContain('in the box')
  })
})

describe('reading the reply', () => {
  test('takes what the tags hold, without a fence', () => {
    expect(extractPrompt('Sure.\n<prompt>\nDo X.\n</prompt>')).toBe('Do X.')
    expect(extractPrompt('```\nDo Y.\n```')).toBe('Do Y.')
    expect(extractPrompt('  Do Z.  ')).toBe('Do Z.')
  })

  test('lists the instruction files from the top down', () => {
    const paths = instructionPaths('/home/me', '/work/app')
    expect(paths[0]).toBe('/home/me/.claude/CLAUDE.md')
    expect(paths).toContain('/CLAUDE.md')
    expect(paths.at(-1)).toBe('/work/app/AGENTS.md')
  })
})
