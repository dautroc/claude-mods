import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Status, Stored } from '../types'
import {
  addTasks,
  advanced,
  changeTasks,
  clearDone,
  describe,
  grouped,
  handedOver,
  keyOf,
  nameOf,
  parseChanges,
  parseIds,
  parseNewTasks,
  parseStored,
  removeTasks,
  requireIds,
} from './board'

type Engine = EngineInterface
type Answer = { result: string } | { deny: string }

const PANE = 'task-board'
// Change the tag when Board's fields change: it declines what an earlier
// version stored, which outlives a reload.
const board = atom({ plugin: 'task-board', key: 'board' } as const, { root: '', tasks: [] }, { shape: 'board-1' })
const draft = atom({ plugin: 'task-board', key: 'draft' } as const, '')

const GLYPHS: Record<Status, { glyph: string; color?: 'warning' | 'success' }> = {
  todo: { glyph: '○' },
  in_progress: { glyph: '◐', color: 'warning' },
  done: { glyph: '✓', color: 'success' },
}

// Changes to the store run one at a time, so two changes close together both land.
let changing: Promise<unknown> = Promise.resolve()

// The project a board belongs to: the repository's root, which for a worktree
// is the main working tree's, so its worktrees share one board. Outside a
// repository, the session's project root.
async function projectRoot($: Engine): Promise<string> {
  const repo = await $.session.repo()

  return repo?.root ?? (await $.session.root())
}

// Reads the project's board from the store into what the pane draws, so the
// changes another session made show too.
async function load($: Engine): Promise<Board> {
  const root = await projectRoot($)
  const { tasks } = parseStored(await $.store.get(keyOf(root)))
  await update($, board, () => ({ root, tasks }))

  return { root, tasks }
}

// Reads the project's board again right before writing it, so what another
// session changed meanwhile is kept. A change that throws writes nothing.
async function write($: Engine, fn: (stored: Stored, now: number) => Stored): Promise<Board> {
  const root = await projectRoot($)
  const key = keyOf(root)
  const stored = fn(parseStored(await $.store.get(key)), await $.clock.now())
  if (stored.tasks.length === 0) {
    await $.store.delete(key)
  } else {
    await $.store.set(key, stored)
  }
  await update($, board, () => ({ root, tasks: stored.tasks }))

  return { root, tasks: stored.tasks }
}

function change($: Engine, fn: (stored: Stored, now: number) => Stored): Promise<Board> {
  const run = changing.then(() => write($, fn))
  changing = run.catch(() => undefined)

  return run
}

// A tool's answer: the board as it now stands, or why nothing changed. A
// change that throws, over a bad input or an id the board lacks, writes
// nothing.
async function answer($: Engine, fn: (stored: Stored, now: number) => Stored): Promise<Answer> {
  let handed: string[] = []
  try {
    const { root, tasks } = await change($, (stored, now) => {
      const changed = fn(stored, now)
      handed = handedOver(stored, changed)

      return changed
    })
    handOver($, handed)

    return { result: describe(nameOf(root), tasks) }
  } catch (error) {
    return { deny: messageOf(error) }
  }
}

function failed(): Answer {
  return { deny: 'The task board could not be read or changed.' }
}

async function list($: Engine): Promise<Answer> {
  try {
    const { root, tasks } = await load($)

    return { result: describe(nameOf(root), tasks) }
  } catch (error) {
    return { deny: messageOf(error) }
  }
}

// Tells the person when the agent hands them a step, since it waits on them.
function handOver($: Engine, titles: string[]) {
  if (titles.length === 1) {
    $.ui.toast(`New task for you: ${titles[0]}. /board opens it.`)
  } else if (titles.length > 1) {
    $.ui.toast(`${titles.length} new tasks for you. /board opens it.`)
  }
}

async function move($: Engine, id: number, status: Status) {
  await change($, (stored, now) => changeTasks(stored, [{ id, status }], now)).catch((error: unknown) =>
    $.ui.toast(`Couldn't change the task: ${messageOf(error)}`),
  )
}

async function remove($: Engine, id: number) {
  await change($, stored => removeTasks(stored, [id])).catch((error: unknown) =>
    $.ui.toast(`Couldn't remove the task: ${messageOf(error)}`),
  )
}

async function clear($: Engine) {
  await change($, clearDone).catch((error: unknown) =>
    $.ui.toast(`Couldn't clear the done tasks: ${messageOf(error)}`),
  )
}

// The pane's field adds a task of the person's own: emptied at once, and given
// back its text if the save fails.
async function submit($: Engine, value: string) {
  const title = value.trim()
  if (title === '') {
    return
  }

  await update($, draft, () => '')
  try {
    await change($, (stored, now) => addTasks(stored, [{ title, owner: 'user', status: 'todo' }], now))
  } catch (error) {
    await update($, draft, () => value)
    $.ui.toast(`Couldn't add the task: ${messageOf(error)}`)
  }
}

async function openBoard($: Engine) {
  const { root } = await load($)
  await $.ui.open({ id: PANE, title: `Tasks · ${nameOf(root)}`, focus: true })
}

function argsOf(e: object): Record<string, unknown> {
  return e as Record<string, unknown>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const STATUS = {
  type: 'string',
  enum: ['todo', 'in_progress', 'done'],
}
const OWNER = {
  type: 'string',
  enum: ['agent', 'user'],
  description: '"agent" for a step you take with your own tools; "user" for one only the person can take.',
}
const DETAIL = {
  type: 'string',
  description:
    'Optional: what the step involves. For a user task, what they need to do it: the command, link, job or branch.',
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'add_tasks',
      description: [
        "Adds tasks to this project's task board, which the person watches in a pane and which stays across sessions.",
        'Keep the board current while you plan and work, in place of a built-in todo list: when work takes more than a couple of steps, add each step as you plan it; mark a task in_progress (update_tasks) as you start it and done as soon as it is finished.',
        'A task is the user\'s (owner "user") when only the person can do it, because your tools can\'t: approving or merging a PR, a build or deploy you have no access to, testing by hand, a decision. Say so in your reply too. Every other task is the agent\'s.',
        'Returns the whole board, each task with its id.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'The step in a few words, as an imperative: "Deploy to staging".' },
                owner: OWNER,
                status: { ...STATUS, description: 'Defaults to "todo".' },
                detail: DETAIL,
              },
              required: ['title', 'owner'],
              additionalProperties: false,
            },
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'update_tasks',
      description: [
        "Changes tasks on this project's task board: status, title, owner or detail, several in one call, such as one task done and the next in_progress.",
        'Mark a task done the moment it is finished, not all together at the end.',
        'The person moves tasks in the pane too, so read the board (list_tasks) before relying on a status you saw earlier.',
        'Returns the whole board.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer', description: "The task's id, as the board shows it (#3 is 3)." },
                status: STATUS,
                title: { type: 'string' },
                owner: OWNER,
                detail: { ...DETAIL, description: `${DETAIL.description} An empty string clears it.` },
              },
              required: ['id'],
              additionalProperties: false,
            },
          },
        },
        required: ['changes'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'remove_tasks',
      description:
        "Removes tasks from this project's task board: ones added by mistake or no longer needed. Mark a finished task done instead. Returns the whole board.",
      inputSchema: {
        type: 'object',
        properties: { ids: { type: 'array', minItems: 1, items: { type: 'integer' } } },
        required: ['ids'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'list_tasks',
      description:
        "Shows this project's task board: the open tasks, the agent's and the user's, and the recently done ones. The board stays across sessions, so read it when you pick up work in this project, and before relying on a status you saw earlier, since the person moves tasks in its pane.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    await $.command.register({
      name: 'board',
      description: "Open the task board: this project's tasks, the agent's and yours, to do, in progress and done",
      immediate: true,
    })

    return next(e)
  })

  on('tool.call', { tool: 'mcp__task-board__add_tasks' }, ($, e) =>
    answer($, (stored, now) => addTasks(stored, parseNewTasks(argsOf(e).tasks), now)),
  ).catch(failed)

  on('tool.call', { tool: 'mcp__task-board__update_tasks' }, ($, e) =>
    answer($, (stored, now) => {
      const changes = parseChanges(argsOf(e).changes)
      requireIds(stored, changes.map(change => change.id))

      return changeTasks(stored, changes, now)
    }),
  ).catch(failed)

  on('tool.call', { tool: 'mcp__task-board__remove_tasks' }, ($, e) =>
    answer($, stored => {
      const ids = parseIds(argsOf(e).ids)
      requireIds(stored, ids)

      return removeTasks(stored, ids)
    }),
  ).catch(failed)

  on('tool.call', { tool: 'mcp__task-board__list_tasks' }, $ => list($)).catch(failed)

  on('command.run', { command: 'board' }, async $ => {
    await openBoard($)

    return {}
  }).catch($ => {
    $.ui.toast("Couldn't open the task board.")

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { tasks } = await read($, board)
    const typing = await read($, draft)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const hasField = 'Input' in ui
    const { in_progress, todo, done } = grouped(tasks)
    const sections = [
      { heading: 'In progress', shown: in_progress },
      { heading: 'To do', shown: todo },
      { heading: 'Done', shown: done },
    ].filter(section => section.shown.length > 0)

    return (
      <Box flexDirection="column" gap={1}>
        {hasField && (
          <ui.Input
            key="new"
            value={typing}
            placeholder="Add a task of your own"
            submitLabel="add"
            autoFocus
            onInput={value => update($, draft, () => value)}
            onSubmit={value => submit($, value)}
          />
        )}
        {tasks.length === 0 && (
          <Text dimColor>
            {`No tasks for this project yet. Claude adds them as it plans and works${hasField ? '; type one above to add your own.' : '.'}`}
          </Text>
        )}
        {sections.map(({ heading, shown }) => (
          <Box flexDirection="column">
            <Box gap={2}>
              <Text bold>{heading}</Text>
              {heading === 'Done' && <Button key="clear-done" label="Clear done" dimColor onPress={() => clear($)} />}
            </Box>
            {shown.map(task => {
              const { glyph, color } = GLYPHS[task.status]
              const next = advanced(task.status)

              return (
                <Box flexDirection="column">
                  <Box gap={1}>
                    <Text {...(color === undefined ? { dimColor: true } : { color })}>{glyph}</Text>
                    <Text dimColor={task.status === 'done'}>{task.title}</Text>
                  </Box>
                  {task.detail !== undefined && task.status !== 'done' && (
                    <Box paddingLeft={2}>
                      <Text dimColor>{task.detail}</Text>
                    </Box>
                  )}
                  <Box gap={2} paddingLeft={2}>
                    <Text dimColor>{`#${task.id}`}</Text>
                    <Text {...(task.owner === 'user' ? { color: 'suggestion' as const, bold: true } : { dimColor: true })}>
                      {task.owner === 'user' ? 'you' : 'Claude'}
                    </Text>
                    <Button
                      key={`advance-${task.id}`}
                      label={next.label}
                      dimColor
                      onPress={() => move($, task.id, next.status)}
                    />
                    <Button key={`remove-${task.id}`} label="Remove" dimColor onPress={() => remove($, task.id)} />
                  </Box>
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  })
}
