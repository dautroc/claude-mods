import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { dayOf } from '../hooks/shelf'

const PANE = {
  plugin: 'idea-shelf',
  component: 'Pane',
  requestId: 'idea-shelf',
  props: {
    title: 'Ideas · shop',
    isFocused: true,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// 2026-10-27 at noon UTC, a day in every time zone's local calendar too.
const NOW = Date.UTC(2026, 9, 27, 12)

// Stands for the engine: a session in `where`'s repository (or in no
// repository when `repo` is null), the mod's store in `seen.store`, which
// refuses writes while `seen.isFull`, and a record of the panes opened and
// the toasts shown.
function engine(on: On, where: { root: string; repo: string | null }, stored: Record<string, unknown> = {}) {
  const seen = { store: { ...stored }, isFull: false, opens: [] as unknown[], toasts: [] as string[] }
  on('store.get', (_, e) => ({ value: seen.store[e.key] }))
  on('store.set', (_, e) => {
    if (seen.isFull) {
      return { deny: 'the store is over 4 MiB' }
    }
    seen.store[e.key] = JSON.parse(JSON.stringify(e.value))

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete seen.store[e.key]

    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: where.root }))
  on('session.repo', () => ({
    value: where.repo === null ? null : { root: where.repo, remote: null, internal: false, name: null },
  }))
  on('ui.open', (_, e) => {
    seen.opens.push(e)

    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(String(e.text))

    return { value: undefined }
  })

  return seen
}

async function start($: Engine) {
  await $.session.start({ cwd: '/work/shop', surface: 'terminal', isInteractive: true })
}

async function command($: Engine, command: string, args = '') {
  return $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

const SHOP = { root: '/work/shop', repo: '/work/shop' }

describe('/idea', () => {
  test('saves the idea to the store under the repository root, and says so', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, SHOP)
    await start($)

    const ran = await command($, 'idea', '  cache the price table  ')

    expect(ran.text).toBeUndefined()
    expect(seen.store['ideas:/work/shop']).toEqual([
      { id: expect.any(String), text: 'cache the price table', savedAt: NOW },
    ])
    expect(seen.toasts).toEqual(['Saved to the idea shelf for shop. /ideas opens it.'])
    expect(seen.opens).toEqual([])
  })

  test('alone, opens the shelf and saves nothing', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, SHOP)
    await start($)

    await command($, 'idea')

    expect(seen.opens).toEqual([expect.objectContaining({ id: 'idea-shelf', title: 'Ideas · shop', focus: true })])
    expect(seen.store['ideas:/work/shop']).toBeUndefined()
  })

  test('a worktree saves to the shelf of its main working tree', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, { root: '/work/shop/.claude/worktrees/fix', repo: '/work/shop' })
    await start($)

    await command($, 'idea', 'split the checkout step')

    expect(seen.store['ideas:/work/shop']).toEqual([expect.objectContaining({ text: 'split the checkout step' })])
  })

  test('outside a repository, saves under the session root', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, { root: '/notes', repo: null })
    await start($)

    await command($, 'idea', 'a weekly digest')

    expect(seen.store['ideas:/notes']).toEqual([expect.objectContaining({ text: 'a weekly digest' })])
  })

  test('keeps an idea another session saved meanwhile', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, SHOP)
    await start($)

    await command($, 'idea', 'first')
    const saved = seen.store['ideas:/work/shop'] as unknown[]
    seen.store['ideas:/work/shop'] = [{ id: 'other', text: 'from another session', savedAt: NOW }, ...saved]
    await command($, 'idea', 'second')

    expect((seen.store['ideas:/work/shop'] as { text: string }[]).map(idea => idea.text)).toEqual([
      'second',
      'from another session',
      'first',
    ])
  })
})

describe('the shelf', () => {
  test("/ideas lists this project's ideas, newest first, and no other project's", async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, SHOP, {
      'ideas:/work/shop': [
        { id: 'b', text: 'newer idea', savedAt: NOW },
        { id: 'a', text: 'older idea', savedAt: NOW - 86_400_000 },
      ],
      'ideas:/work/blog': [{ id: 'c', text: 'a blog idea', savedAt: NOW }],
    })
    await start($)

    await command($, 'ideas')

    expect(seen.opens).toEqual([expect.objectContaining({ id: 'idea-shelf', title: 'Ideas · shop' })])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts).toEqual(['newer idea', dayOf(NOW), 'older idea', dayOf(NOW - 86_400_000)])
    await ui.unmount()
  })

  test('the field saves an idea, which then heads the list', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, SHOP, { 'ideas:/work/shop': [{ id: 'a', text: 'older idea', savedAt: NOW }] })
    await start($)
    await command($, 'ideas')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'new', text: 'retry the webhook' })

    expect((seen.store['ideas:/work/shop'] as { text: string }[]).map(idea => idea.text)).toEqual([
      'retry the webhook',
      'older idea',
    ])
    expect((await ui.findAll({ type: 'Text' })).map(found => found.text)[0]).toBe('retry the webhook')
    expect((await ui.find({ key: 'new' }))?.props.value).toBe('')
    await ui.unmount()
  })

  test('Remove takes the idea off the shelf, and the last one empties the store key', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, SHOP, {
      'ideas:/work/shop': [
        { id: 'b', text: 'keep me', savedAt: NOW },
        { id: 'a', text: 'drop me', savedAt: NOW },
      ],
    })
    await start($)
    await command($, 'ideas')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'remove-a' })
    expect(seen.store['ideas:/work/shop']).toEqual([{ id: 'b', text: 'keep me', savedAt: NOW }])

    await ui.press({ key: 'remove-b' })
    expect(Object.keys(seen.store)).toEqual([])
    expect((await ui.find({ type: 'Text' }))?.text).toMatch(/^No ideas saved for this project yet/)
    await ui.unmount()
  })

  test('passes over what the store holds that is no idea', async ($, on) => {
    mock.clock(on, { now: NOW })
    engine(on, SHOP, { 'ideas:/work/shop': [{ id: 'a', text: 'real', savedAt: NOW }, { text: 'no id' }, 'junk'] })
    await start($)
    await command($, 'ideas')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual(['real', dayOf(NOW)])
    await ui.unmount()
  })

  test('a save that fails says why, and the field keeps the idea', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, SHOP)
    await start($)
    await command($, 'ideas')
    seen.isFull = true

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'new', text: 'retry the webhook' })

    expect(seen.toasts).toEqual([expect.stringMatching(/^Couldn't save the idea: .*over 4 MiB/)])
    expect((await ui.find({ key: 'new' }))?.props.value).toBe('retry the webhook')
    expect(seen.store).toEqual({})
    await ui.unmount()
  })

  test('draws on every surface, a field where the surface has one', async ($, on) => {
    mock.clock(on, { now: NOW })
    engine(on, SHOP, { 'ideas:/work/shop': [{ id: 'a', text: 'an idea', savedAt: NOW }] })
    await start($)
    await command($, 'ideas')

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /an idea/ }))?.text).toBe('an idea')
      expect((await ui.find({ key: 'remove-a' })) === undefined).toBe(false)
      // Claude Code 2.1.318's test kit gives mobile an Input too, though its
      // types say the app draws no field yet: the pane draws one wherever the
      // surface's table has it, so mobile is left to the table.
      if (surface !== 'mobile') {
        expect((await ui.find({ key: 'new' }))?.type).toBe('Input')
      }
      await ui.unmount()
    }
  })
})
