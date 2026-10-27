import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Idea, Shelf } from '../types'
import { dayOf, keyOf, nameOf, parseIdeas } from './shelf'

type Engine = EngineInterface
type Saved = { isSaved: true; root: string } | { isSaved: false; why: string }

const PANE = 'idea-shelf'
// Change the tag when Shelf's fields change: it declines what an earlier
// version stored, which outlives a reload.
const shelf = atom({ plugin: 'idea-shelf', key: 'shelf' } as const, { root: '', ideas: [] }, { shape: 'shelf-1' })
const draft = atom({ plugin: 'idea-shelf', key: 'draft' } as const, '')

// What was typed after /idea, held here so that the command's record in the
// main conversation carries no arguments.
let typed = ''

// Changes to the store run one at a time, so two saves close together both land.
let changing: Promise<unknown> = Promise.resolve()

// The project a shelf belongs to: the repository's root, which for a worktree
// is the main working tree's, so its worktrees share one shelf. Outside a
// repository, the session's project root.
async function projectRoot($: Engine): Promise<string> {
  const repo = await $.session.repo()

  return repo?.root ?? (await $.session.root())
}

// Reads the project's ideas from the store into what the pane draws, so those
// another session saved show too.
async function load($: Engine): Promise<Shelf> {
  const root = await projectRoot($)
  const ideas = parseIdeas(await $.store.get(keyOf(root)))
  await update($, shelf, () => ({ root, ideas }))

  return { root, ideas }
}

// Reads the project's ideas again right before writing them, so what another
// session saved meanwhile is kept.
async function write($: Engine, change: (ideas: Idea[]) => Idea[]): Promise<Shelf> {
  const root = await projectRoot($)
  const key = keyOf(root)
  const ideas = change(parseIdeas(await $.store.get(key)))
  if (ideas.length === 0) {
    await $.store.delete(key)
  } else {
    await $.store.set(key, ideas)
  }
  await update($, shelf, () => ({ root, ideas }))

  return { root, ideas }
}

function change($: Engine, fn: (ideas: Idea[]) => Idea[]): Promise<Shelf> {
  const run = changing.then(() => write($, fn))
  changing = run.catch(() => undefined)

  return run
}

async function save($: Engine, text: string): Promise<Saved> {
  const idea: Idea = { id: crypto.randomUUID(), text, savedAt: await $.clock.now() }

  try {
    const { root } = await change($, ideas => [idea, ...ideas])

    return { isSaved: true, root }
  } catch (error) {
    return { isSaved: false, why: error instanceof Error ? error.message : String(error) }
  }
}

async function remove($: Engine, id: string) {
  await change($, ideas => ideas.filter(idea => idea.id !== id)).catch((error: unknown) =>
    $.ui.toast(`Couldn't remove the idea: ${error instanceof Error ? error.message : String(error)}`),
  )
}

async function openShelf($: Engine) {
  const { root } = await load($)
  await $.ui.open({ id: PANE, title: `Ideas · ${nameOf(root)}`, focus: true })
}

// The pane's field: emptied at once, and given back its text if the save fails.
async function submit($: Engine, value: string) {
  const text = value.trim()
  if (text === '') {
    return
  }

  await update($, draft, () => '')
  const saved = await save($, text)
  if (!saved.isSaved) {
    await update($, draft, () => value)
    $.ui.toast(`Couldn't save the idea: ${saved.why}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'idea',
      description: "Save an idea to this project's idea shelf, kept out of the main conversation; alone, opens the shelf",
      argumentHint: '[idea]',
      immediate: true,
    })
    await $.command.register({
      name: 'ideas',
      description: 'Open the idea shelf: the ideas saved for this project',
      immediate: true,
    })

    return next(e)
  })

  // Registered first, so it runs first: the row the main conversation keeps
  // for /idea then holds the command and no idea.
  on('command.run', { command: 'idea' }, ($, e, next) => {
    typed = e.args

    return next({ ...e, args: '' })
  }).catch(($, e, next) => (next.called ? next(e) : next({ ...e, args: '' })))

  on('command.run', { command: 'idea' }, async $ => {
    const text = typed.trim()
    typed = ''
    if (text === '') {
      await openShelf($)

      return {}
    }

    const saved = await save($, text)
    $.ui.toast(
      saved.isSaved
        ? `Saved to the idea shelf for ${nameOf(saved.root)}. /ideas opens it.`
        : `Couldn't save the idea: ${saved.why}`,
    )

    return {}
  })

  on('command.run', { command: 'ideas' }, async $ => {
    await openShelf($)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { ideas } = await read($, shelf)
    const typing = await read($, draft)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const hasField = 'Input' in ui

    return (
      <Box flexDirection="column" gap={1}>
        {hasField && (
          <ui.Input
            key="new"
            value={typing}
            placeholder="Add an idea for this project"
            submitLabel="save"
            autoFocus
            onInput={value => update($, draft, () => value)}
            onSubmit={value => submit($, value)}
          />
        )}
        {ideas.length === 0 && (
          <Text dimColor>
            {hasField
              ? 'No ideas saved for this project yet. Type one above, or send /idea and the idea.'
              : 'No ideas saved for this project yet. Send /idea and the idea to save one.'}
          </Text>
        )}
        {ideas.map(idea => (
          <Box flexDirection="column">
            <Text>{idea.text}</Text>
            <Box gap={2}>
              <Text dimColor>{dayOf(idea.savedAt)}</Text>
              <Button key={`remove-${idea.id}`} label="Remove" dimColor onPress={() => remove($, idea.id)} />
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
