// A project's tasks as the store keeps them, the changes the agent's tools and
// the pane make to them, and how the board reads to the model.

import type { Owner, Status, Stored, Task } from '../types'

export type NewTask = { title: string; owner: Owner; status: Status; detail?: string }
export type Change = { id: number; title?: string; owner?: Owner; status?: Status; detail?: string }

const OWNERS: readonly unknown[] = ['agent', 'user'] satisfies Owner[]
const STATUSES: readonly unknown[] = ['todo', 'in_progress', 'done'] satisfies Status[]

// How many done tasks the model is shown, the most recently done first.
const DONE_SHOWN = 10

// One store key per project, by its root.
export function keyOf(root: string): string {
  return `tasks:${root}`
}

// The board a store value holds. Anything in it that is no task is passed
// over rather than failing the board, and `next` stays past every id in it.
export function parseStored(value: unknown): Stored {
  const record = isRecord(value) ? value : {}
  const tasks = Array.isArray(record.tasks) ? record.tasks.filter(isTask) : []
  const after = Math.max(0, ...tasks.map(task => task.id)) + 1
  const next = isId(record.next) ? Math.max(record.next, after) : after

  return { next, tasks }
}

function isTask(value: unknown): value is Task {
  if (!isRecord(value)) {
    return false
  }

  const { id, title, detail, owner, status, createdAt, updatedAt } = value

  return (
    isId(id) &&
    typeof title === 'string' &&
    title !== '' &&
    (detail === undefined || typeof detail === 'string') &&
    OWNERS.includes(owner) &&
    STATUSES.includes(status) &&
    typeof createdAt === 'number' &&
    typeof updatedAt === 'number'
  )
}

// What the agent's tools were called with. Each throws, saying what is wrong,
// when the input is not what the tool's schema asks for.

export function parseNewTasks(input: unknown): NewTask[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('`tasks` must be a list of at least one task.')
  }

  return input.map((item, i) => {
    const at = `tasks[${i}]`
    if (!isRecord(item)) {
      throw new Error(`${at} must be an object.`)
    }

    return {
      title: titleOf(item.title, at),
      owner: item.owner === undefined ? 'agent' : ownerOf(item.owner, at),
      status: item.status === undefined ? 'todo' : statusOf(item.status, at),
      ...detailOf(item.detail, at),
    }
  })
}

export function parseChanges(input: unknown): Change[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('`changes` must be a list of at least one change.')
  }

  return input.map((item, i) => {
    const at = `changes[${i}]`
    if (!isRecord(item) || !isId(item.id)) {
      throw new Error(`${at} must be an object with the task's \`id\`, a number.`)
    }

    return {
      id: item.id,
      ...(item.title === undefined ? {} : { title: titleOf(item.title, at) }),
      ...(item.owner === undefined ? {} : { owner: ownerOf(item.owner, at) }),
      ...(item.status === undefined ? {} : { status: statusOf(item.status, at) }),
      ...(item.detail === undefined ? {} : { detail: detailOf(item.detail, at).detail ?? '' }),
    }
  })
}

export function parseIds(input: unknown): number[] {
  if (!Array.isArray(input) || input.length === 0 || !input.every(isId)) {
    throw new Error('`ids` must be a list of at least one task id, each a number.')
  }

  return input
}

function titleOf(value: unknown, at: string): string {
  const title = typeof value === 'string' ? value.trim() : ''
  if (title === '') {
    throw new Error(`${at}.title must be a non-empty string.`)
  }

  return title
}

function ownerOf(value: unknown, at: string): Owner {
  if (!OWNERS.includes(value)) {
    throw new Error(`${at}.owner must be "agent" or "user".`)
  }

  return value as Owner
}

function statusOf(value: unknown, at: string): Status {
  if (!STATUSES.includes(value)) {
    throw new Error(`${at}.status must be "todo", "in_progress" or "done".`)
  }

  return value as Status
}

function detailOf(value: unknown, at: string): { detail?: string } {
  if (value === undefined) {
    return {}
  }
  if (typeof value !== 'string') {
    throw new Error(`${at}.detail must be a string.`)
  }

  const detail = value.trim()

  return detail === '' ? {} : { detail }
}

// The changes, each made to the board as it stands right before the write.

// Refuses ids the board doesn't hold, so a tool call that names one changes
// nothing.
export function requireIds(stored: Stored, ids: number[]) {
  const missing = ids.filter(id => !stored.tasks.some(task => task.id === id))
  if (missing.length > 0) {
    throw new Error(`No task ${missing.map(id => `#${id}`).join(', ')} on this board; nothing was changed.`)
  }
}

export function addTasks(stored: Stored, adds: NewTask[], now: number): Stored {
  let next = stored.next
  const added = adds.map(add => ({ id: next++, ...add, createdAt: now, updatedAt: now }))

  return { next, tasks: [...stored.tasks, ...added] }
}

// Ids the board doesn't hold are passed over. An empty `detail` clears it.
export function changeTasks(stored: Stored, changes: Change[], now: number): Stored {
  const tasks = stored.tasks.map(task =>
    changes.filter(change => change.id === task.id).reduce<Task>((changed, change) => applied(changed, change, now), task),
  )

  return { next: stored.next, tasks }
}

function applied(task: Task, change: Change, now: number): Task {
  const detail = change.detail ?? task.detail

  return {
    id: task.id,
    title: change.title ?? task.title,
    ...(detail === undefined || detail === '' ? {} : { detail }),
    owner: change.owner ?? task.owner,
    status: change.status ?? task.status,
    createdAt: task.createdAt,
    updatedAt: now,
  }
}

export function removeTasks(stored: Stored, ids: number[]): Stored {
  return { next: stored.next, tasks: stored.tasks.filter(task => !ids.includes(task.id)) }
}

export function clearDone(stored: Stored): Stored {
  return { next: stored.next, tasks: stored.tasks.filter(task => task.status !== 'done') }
}

// The titles of the tasks a change hands the person: added as theirs, or made
// theirs.
export function handedOver(before: Stored, after: Stored): string[] {
  const theirs = new Set(before.tasks.filter(task => task.owner === 'user').map(task => task.id))

  return after.tasks.filter(task => task.owner === 'user' && !theirs.has(task.id)).map(task => task.title)
}

// What a press moves a task to in the pane: to do, then in progress, then
// done, and a done task back to do.
export function advanced(status: Status): { status: Status; label: string } {
  switch (status) {
    case 'todo':
      return { status: 'in_progress', label: 'Start' }
    case 'in_progress':
      return { status: 'done', label: 'Done' }
    case 'done':
      return { status: 'todo', label: 'Reopen' }
  }
}

// The tasks by status: open ones in the order they were added, done ones the
// most recently done first.
export function grouped(tasks: Task[]): Record<Status, Task[]> {
  return {
    in_progress: tasks.filter(task => task.status === 'in_progress'),
    todo: tasks.filter(task => task.status === 'todo'),
    done: tasks
      .filter(task => task.status === 'done')
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id),
  }
}

// The board as each tool's result gives it to the model.
export function describe(name: string, tasks: Task[]): string {
  if (tasks.length === 0) {
    return `The task board for ${name} is empty.`
  }

  const { in_progress, todo, done } = grouped(tasks)
  const lines = [
    `Task board for ${name}: ${in_progress.length} in progress, ${todo.length} to do, ${done.length} done.`,
  ]
  const section = (heading: string, shown: Task[], withDetail: boolean) => {
    if (shown.length === 0) {
      return
    }
    lines.push('', `${heading}:`)
    for (const task of shown) {
      lines.push(`- #${task.id} (${task.owner}) ${task.title}`)
      if (withDetail && task.detail !== undefined) {
        lines.push(...task.detail.split('\n').map(line => `    ${line}`))
      }
    }
  }
  section('In progress', in_progress, true)
  section('To do', todo, true)
  section('Done', done.slice(0, DONE_SHOWN), false)
  if (done.length > DONE_SHOWN) {
    lines.push(`- and ${done.length - DONE_SHOWN} done earlier`)
  }

  return lines.join('\n')
}

// The project's folder name, for the pane's title, the toasts and the model.
export function nameOf(root: string): string {
  return root.split('/').filter(part => part !== '').at(-1) ?? root
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
