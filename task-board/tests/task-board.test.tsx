import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, Mounted } from 'claude-code/testing'

import type { Stored, Task } from '../types'

const PANE = {
  plugin: 'task-board',
  component: 'Pane',
  requestId: 'task-board',
  props: {
    title: 'Tasks · shop',
    isFocused: true,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const NOW = Date.UTC(2026, 9, 27, 12)
const KEY = 'tasks:/work/shop'

// Stands for the engine: a session in `where`'s repository (or in no
// repository when `repo` is null), the mod's store in `seen.store`, which
// refuses writes while `seen.isFull`, and a record of the tools and commands
// registered, the panes opened and the toasts shown.
function engine(
  on: On,
  where: { root: string; repo: string | null } = SHOP,
  stored: Record<string, unknown> = {},
) {
  const seen = {
    store: { ...stored },
    isFull: false,
    tools: [] as { name: string; isDeferred?: boolean }[],
    commands: [] as string[],
    opens: [] as unknown[],
    toasts: [] as string[],
  }
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
  on('tool.register', (_, e) => {
    seen.tools.push({ name: e.name, isDeferred: e.isDeferred })

    return { value: { tool: `mcp__task-board__${e.name}` } }
  })
  on('command.register', (_, e) => {
    seen.commands.push(e.name)

    return { value: { command: e.name } }
  })
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

const SHOP = { root: '/work/shop', repo: '/work/shop' }

async function start($: Engine) {
  await $.session.start({ cwd: '/work/shop', surface: 'terminal', isInteractive: true })
}

function call($: Engine, name: string, input: Record<string, unknown> = {}) {
  return $.tool.call({ tool: `mcp__task-board__${name}`, ...input })
}

async function command($: Engine, command: string) {
  return $.command.run({
    command,
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

function task(id: number, title: string, rest: Partial<Task> = {}): Task {
  return { id, title, owner: 'agent', status: 'todo', createdAt: NOW, updatedAt: NOW, ...rest }
}

function board(...tasks: Task[]): Stored {
  return { next: Math.max(0, ...tasks.map(t => t.id)) + 1, tasks }
}

function titles(seen: { store: Record<string, unknown> }) {
  return ((seen.store[KEY] as Stored | undefined)?.tasks ?? []).map(t => `#${t.id} ${t.status} ${t.title}`)
}

describe('the tools', () => {
  test('are registered with their schemas in the prompt, beside /board', async ($, on) => {
    const seen = engine(on)
    await start($)

    expect(seen.tools).toEqual([
      { name: 'add_tasks', isDeferred: false },
      { name: 'update_tasks', isDeferred: false },
      { name: 'remove_tasks', isDeferred: false },
      { name: 'list_tasks', isDeferred: false },
    ])
    expect(seen.commands).toEqual(['board'])
  })

  test("add_tasks stores the tasks under the repository root, numbered, and answers with the board", async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on)
    await start($)

    const added = await call($, 'add_tasks', {
      tasks: [
        { title: 'Create the PR', owner: 'agent', status: 'in_progress' },
        { title: '  Build dev and staging ', owner: 'user', detail: 'Dev sync, then staging' },
        { title: 'Test the sync on stag', owner: 'user' },
      ],
    })

    expect(seen.store[KEY]).toEqual({
      next: 4,
      tasks: [
        task(1, 'Create the PR', { status: 'in_progress' }),
        task(2, 'Build dev and staging', { owner: 'user', detail: 'Dev sync, then staging' }),
        task(3, 'Test the sync on stag', { owner: 'user' }),
      ],
    })
    expect(added.result).toBe(
      [
        'Task board for shop: 1 in progress, 2 to do, 0 done.',
        '',
        'In progress:',
        '- #1 (agent) Create the PR',
        '',
        'To do:',
        '- #2 (user) Build dev and staging',
        '    Dev sync, then staging',
        '- #3 (user) Test the sync on stag',
      ].join('\n'),
    )
    expect(seen.toasts).toEqual(['2 new tasks for you. /board opens it.'])
  })

  test('a worktree adds to the board of its main working tree', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, { root: '/work/shop/.claude/worktrees/fix', repo: '/work/shop' })
    await start($)

    await call($, 'add_tasks', { tasks: [{ title: 'Fix the checkout', owner: 'agent' }] })

    expect(titles(seen)).toEqual(['#1 todo Fix the checkout'])
    expect(seen.toasts).toEqual([])
  })

  test('outside a repository, adds under the session root', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, { root: '/notes', repo: null })
    await start($)

    await call($, 'add_tasks', { tasks: [{ title: 'Sort the notes', owner: 'agent' }] })

    expect(Object.keys(seen.store)).toEqual(['tasks:/notes'])
  })

  test('a bad input is refused, saying what is wrong, and changes nothing', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on)
    await start($)

    expect((await call($, 'add_tasks', { tasks: [] })).deny).toMatch(/`tasks` must be a list/)
    expect((await call($, 'add_tasks', { tasks: [{ title: ' ', owner: 'agent' }] })).deny).toMatch(
      /tasks\[0\]\.title must be a non-empty string/,
    )
    expect((await call($, 'add_tasks', { tasks: [{ title: 'x', owner: 'me' }] })).deny).toMatch(
      /tasks\[0\]\.owner must be "agent" or "user"/,
    )
    expect((await call($, 'update_tasks', { changes: [{ id: 1, status: 'started' }] })).deny).toMatch(
      /changes\[0\]\.status must be/,
    )
    expect((await call($, 'remove_tasks', { ids: ['1'] })).deny).toMatch(/`ids` must be a list/)
    expect(seen.store).toEqual({})
  })

  test('update_tasks moves tasks along, several in one call', async ($, on) => {
    mock.clock(on, { now: NOW + 1000 })
    const seen = engine(on, SHOP, {
      [KEY]: board(task(1, 'Create the PR', { status: 'in_progress' }), task(2, 'Update the CHANGELOG')),
    })
    await start($)

    const updated = await call($, 'update_tasks', {
      changes: [
        { id: 1, status: 'done' },
        { id: 2, status: 'in_progress', detail: 'under Unreleased' },
      ],
    })

    expect((seen.store[KEY] as Stored).tasks).toEqual([
      task(1, 'Create the PR', { status: 'done', updatedAt: NOW + 1000 }),
      task(2, 'Update the CHANGELOG', { status: 'in_progress', detail: 'under Unreleased', updatedAt: NOW + 1000 }),
    ])
    expect(updated.result).toMatch(/1 in progress, 0 to do, 1 done\.[\s\S]*Done:\n- #1 \(agent\) Create the PR$/)
    expect(seen.toasts).toEqual([])
  })

  test('update_tasks handing a task to the person tells them, and an empty detail clears it', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, SHOP, { [KEY]: board(task(1, 'Merge the PR', { detail: 'after review' })) })
    await start($)

    await call($, 'update_tasks', { changes: [{ id: 1, owner: 'user', detail: '' }] })

    expect((seen.store[KEY] as Stored).tasks).toEqual([task(1, 'Merge the PR', { owner: 'user' })])
    expect(seen.toasts).toEqual(['New task for you: Merge the PR. /board opens it.'])
  })

  test('a call naming a task the board lacks is refused and changes nothing', async ($, on) => {
    mock.clock(on, { now: NOW })
    const before = board(task(1, 'Create the PR'))
    const seen = engine(on, SHOP, { [KEY]: before })
    await start($)

    const updated = await call($, 'update_tasks', {
      changes: [
        { id: 1, status: 'done' },
        { id: 7, status: 'done' },
      ],
    })
    const removed = await call($, 'remove_tasks', { ids: [1, 8] })

    expect(updated.deny).toBe('No task #7 on this board; nothing was changed.')
    expect(removed.deny).toBe('No task #8 on this board; nothing was changed.')
    expect(seen.store[KEY]).toEqual(before)
  })

  test('remove_tasks takes tasks off, and the last one empties the store key', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, SHOP, { [KEY]: board(task(1, 'Keep'), task(2, 'Drop')) })
    await start($)

    expect((await call($, 'remove_tasks', { ids: [2] })).result).toMatch(/0 in progress, 1 to do, 0 done/)
    expect(titles(seen)).toEqual(['#1 todo Keep'])

    expect((await call($, 'remove_tasks', { ids: [1] })).result).toBe('The task board for shop is empty.')
    expect(seen.store).toEqual({})
  })

  test('list_tasks reads what another session stored, the 10 latest done tasks shown', async ($, on) => {
    mock.clock(on, { now: NOW })
    const done = Array.from({ length: 12 }, (_, i) =>
      task(i + 2, `Step ${i + 2}`, { status: 'done', updatedAt: NOW + i }),
    )
    engine(on, SHOP, { [KEY]: board(task(1, 'Test on stag', { owner: 'user' }), ...done) })
    await start($)

    const listed = (await call($, 'list_tasks')).result as string

    expect(listed).toMatch(/^Task board for shop: 0 in progress, 1 to do, 12 done\./)
    expect(listed).toMatch(/Done:\n- #13 \(agent\) Step 13\n- #12 /)
    expect(listed).not.toMatch(/Step 3$|Step 2\n/m)
    expect(listed).toMatch(/- and 2 done earlier$/)
  })

  test('keeps what another session changed meanwhile, and numbers past it', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on)
    await start($)

    await call($, 'add_tasks', { tasks: [{ title: 'First', owner: 'agent' }] })
    const stored = seen.store[KEY] as Stored
    seen.store[KEY] = { next: 3, tasks: [...stored.tasks, task(2, 'From another session')] }
    await call($, 'add_tasks', { tasks: [{ title: 'Second', owner: 'agent' }] })

    expect(titles(seen)).toEqual(['#1 todo First', '#2 todo From another session', '#3 todo Second'])
  })

  test('a store that refuses the write is reported to the model', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on)
    await start($)
    seen.isFull = true

    const added = await call($, 'add_tasks', { tasks: [{ title: 'x', owner: 'user' }] })

    expect(added.deny).toMatch(/over 4 MiB/)
    expect(seen.toasts).toEqual([])
  })
})

describe('the pane', () => {
  async function texts(ui: Pick<Mounted, 'findAll'>) {
    return (await ui.findAll({ type: 'Text' })).map(found => found.text)
  }

  test("/board opens this project's board, in progress first, then to do, then done newest first", async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, SHOP, {
      [KEY]: board(
        task(1, 'Create the PR', { status: 'done', updatedAt: NOW }),
        task(2, 'Build stag', { owner: 'user', status: 'in_progress', detail: 'Staging sync' }),
        task(3, 'Test on stag', { owner: 'user' }),
        task(4, 'Write the notes', { status: 'done', updatedAt: NOW + 5 }),
      ),
      'tasks:/work/blog': board(task(1, 'A blog task')),
    })
    await start($)

    await command($, 'board')

    expect(seen.opens).toEqual([expect.objectContaining({ id: 'task-board', title: 'Tasks · shop', focus: true })])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await texts(ui)).toEqual([
      'In progress',
      '◐',
      'Build stag',
      'Staging sync',
      '#2',
      'you',
      'To do',
      '○',
      'Test on stag',
      '#3',
      'you',
      'Done',
      '✓',
      'Write the notes',
      '#4',
      'Claude',
      '✓',
      'Create the PR',
      '#1',
      'Claude',
    ])
    expect((await ui.find({ key: 'advance-2' }))?.props.label).toBe('Done')
    expect((await ui.find({ key: 'advance-3' }))?.props.label).toBe('Start')
    expect((await ui.find({ key: 'advance-4' }))?.props.label).toBe('Reopen')
    await ui.unmount()
  })

  test('Start, Done and Reopen move a task, and the person is told nothing', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, SHOP, { [KEY]: board(task(1, 'Test on stag', { owner: 'user' })) })
    await start($)
    await command($, 'board')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'advance-1' })
    expect(titles(seen)).toEqual(['#1 in_progress Test on stag'])
    await ui.press({ key: 'advance-1' })
    expect(titles(seen)).toEqual(['#1 done Test on stag'])
    await ui.press({ key: 'advance-1' })
    expect(titles(seen)).toEqual(['#1 todo Test on stag'])
    expect(seen.toasts).toEqual([])
    await ui.unmount()
  })

  test('Remove and Clear done take tasks off', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on, SHOP, {
      [KEY]: board(task(1, 'Keep'), task(2, 'Drop'), task(3, 'Finished', { status: 'done' })),
    })
    await start($)
    await command($, 'board')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'remove-2' })
    expect(titles(seen)).toEqual(['#1 todo Keep', '#3 done Finished'])
    await ui.press({ key: 'clear-done' })
    expect(titles(seen)).toEqual(['#1 todo Keep'])
    expect(await ui.find({ key: 'clear-done' })).toBeUndefined()
    await ui.unmount()
  })

  test("the field adds a task of the person's own, with no toast", async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on)
    await start($)
    await command($, 'board')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await texts(ui))[0]).toMatch(/^No tasks for this project yet/)
    await ui.input({ key: 'new', text: 'Ask QA about the sync' })

    expect((seen.store[KEY] as Stored).tasks).toEqual([task(1, 'Ask QA about the sync', { owner: 'user' })])
    expect(await texts(ui)).toEqual(['To do', '○', 'Ask QA about the sync', '#1', 'you'])
    expect((await ui.find({ key: 'new' }))?.props.value).toBe('')
    expect(seen.toasts).toEqual([])
    await ui.unmount()
  })

  test('an add that fails says why, and the field keeps the text', async ($, on) => {
    mock.clock(on, { now: NOW })
    const seen = engine(on)
    await start($)
    await command($, 'board')
    seen.isFull = true

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'new', text: 'Ask QA' })

    expect(seen.toasts).toEqual([expect.stringMatching(/^Couldn't add the task: .*over 4 MiB/)])
    expect((await ui.find({ key: 'new' }))?.props.value).toBe('Ask QA')
    await ui.unmount()
  })

  test('passes over what the store holds that is no task', async ($, on) => {
    mock.clock(on, { now: NOW })
    engine(on, SHOP, { [KEY]: { next: 'x', tasks: [task(1, 'Real'), { id: 2, title: 'no owner' }, 'junk'] } })
    await start($)
    await command($, 'board')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await texts(ui)).toEqual(['To do', '○', 'Real', '#1', 'Claude'])
    await ui.unmount()
  })

  test('draws on every surface, a field where the surface has one', async ($, on) => {
    mock.clock(on, { now: NOW })
    engine(on, SHOP, { [KEY]: board(task(1, 'Build stag', { owner: 'user' })) })
    await start($)
    await command($, 'board')

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /Build stag/ }))?.text).toBe('Build stag')
      expect((await ui.find({ key: 'advance-1' })) === undefined).toBe(false)
      expect((await ui.find({ key: 'new' })) === undefined).toBe(surface === 'mobile')
      await ui.unmount()
    }
  })
})
