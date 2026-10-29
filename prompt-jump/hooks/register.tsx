import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Prompt } from '../types'
import {
  REPLY,
  TYPED,
  inConversation,
  lastReply,
  matching,
  parsePrompts,
  plainOf,
  snippet,
  timeOf,
  widthOf,
} from './prompts'

type Engine = EngineInterface

const PANE = 'prompt-jump'
const GREP = '/usr/bin/grep'
// The matches drawn at most; typing more narrows the rest.
const SHOWN = 100
// The characters of a prompt kept to search, so a long paste keeps the
// session's state small.
const KEPT = 20_000

// Change the tag when Prompt's fields change: it declines what an earlier
// version stored, which outlives a reload.
const prompts = atom({ plugin: 'prompt-jump', key: 'prompts' } as const, [] as Prompt[], { shape: 'prompts-1' })
const query = atom({ plugin: 'prompt-jump', key: 'query' } as const, '')

// This session's transcript file, once found.
let file: { sessionId: string; path: string } | undefined

// The folder name Claude Code gives a project: its path with each character
// but a letter or digit made a dash.
function folderOf(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

async function transcriptFile($: Engine): Promise<string | undefined> {
  const sessionId = await $.session.id()
  if (file?.sessionId === sessionId) {
    return file.path
  }

  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
  const projects = `${config}/projects`
  const at = async (name: string) => {
    const path = `${projects}/${name}/${sessionId}.jsonl`
    if (await $.fs.exists(path)) {
      file = { sessionId, path }

      return path
    }

    return undefined
  }

  // The file sits in a folder named after the one the session started in,
  // which the API doesn't give: the session's own folders are tried first,
  // then every project's, as a long path's folder name is hashed.
  for (const name of new Set([folderOf(await $.session.cwd()), folderOf(await $.session.root())])) {
    const path = await at(name)
    if (path !== undefined) {
      return path
    }
  }
  for (const entry of await $.fs.list(projects).catch(() => [])) {
    const path = entry.kind === 'dir' ? await at(entry.name) : undefined
    if (path !== undefined) {
      return path
    }
  }

  return undefined
}

// The lines of this session's transcript file that hold `text`, or why they
// can't be read.
async function grepTranscript($: Engine, text: string): Promise<{ lines: string } | { error: string }> {
  const path = await transcriptFile($)
  if (path === undefined) {
    return { error: "Couldn't find this session's transcript file." }
  }

  // grep exits 1 when no line matches.
  const ran = await $.process.run([GREP, '-F', text, path])
  if (ran.exitCode > 1) {
    return { error: `Couldn't read this session's transcript: ${ran.stderr.trim() || `grep exited with ${ran.exitCode}`}` }
  }

  return { lines: ran.stdout }
}

// The prompts typed into this chat that it still shows, oldest first, or why
// they can't be read.
async function load($: Engine, rows: readonly { role: string; text: string }[]): Promise<Prompt[] | string> {
  const read = await grepTranscript($, TYPED)
  if ('error' in read) {
    return read.error
  }

  return inConversation(parsePrompts(read.lines), rows).map(prompt => ({
    ...prompt,
    text: plainOf(prompt.text).slice(0, KEPT),
  }))
}

async function openSearch($: Engine) {
  const rows = await $.session.messages()
  const found = rows.some(row => row.role === 'user') ? await load($, rows) : []
  if (typeof found === 'string') {
    $.ui.toast(found)

    return
  }
  if (found.length === 0) {
    $.ui.toast('No prompts typed in this chat yet.')

    return
  }

  await update($, prompts, () => found)
  await update($, query, () => '')
  await $.ui.open({ id: PANE, title: 'Jump to a prompt', focus: true, closeOnEscape: true })
}

// Scrolls the chat so the row drawn under `id` heads it; answers why not when
// it didn't move.
async function scrollTo($: Engine, id: string): Promise<string | undefined> {
  const moved = await $.ui
    .scroll({ to: { requestId: id }, block: 'start' })
    .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))

  return moved.deny
}

// Scrolls the chat to the prompt's row. The pane closes first, so the row is
// placed in the chat at its full width.
async function jump($: Engine, prompt: Prompt) {
  await $.ui.close({ id: PANE })
  const why = await scrollTo($, prompt.id)
  if (why !== undefined) {
    $.ui.toast(`Couldn't scroll to prompt #${prompt.number}: ${why}`)
  }
}

// Scrolls the chat to the start of the last text Claude wrote: the answer a
// turn ended on, after its tool calls.
async function jumpToReply($: Engine) {
  const rows = await $.session.messages()
  const read = rows.some(row => row.role === 'assistant' && row.text.trim() !== '')
    ? await grepTranscript($, REPLY)
    : { lines: '' }
  if ('error' in read) {
    $.ui.toast(read.error)

    return
  }

  const id = lastReply(read.lines)
  if (id === undefined) {
    $.ui.toast("Claude hasn't replied in this chat yet.")

    return
  }

  const why = await scrollTo($, id)
  if (why !== undefined) {
    $.ui.toast(`Couldn't scroll to Claude's last reply: ${why}`)
  }
}

async function jumpToFirst($: Engine, value: string) {
  const first = matching(await read($, prompts), value)[0]
  if (first !== undefined) {
    await jump($, first)
  }
}

function count(n: number): string {
  return n === 1 ? '1 prompt' : `${n} prompts`
}

function summaryOf(total: number, found: number, typed: string): string {
  if (typed.trim() === '') {
    return `${count(total)}, newest first`
  }
  if (found === 0) {
    return `No prompt holds "${typed.trim()}"`
  }

  return `${found} of ${count(total)} match`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jump',
      description: 'Search the prompts you typed in this chat and scroll the chat to the one you pick',
      immediate: true,
    })
    await $.command.register({
      name: 'jump-reply',
      description: "Scroll the chat to the start of Claude's last reply",
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'jump-reply' }, async ($, e) => {
    if (!e.presentation.isFullscreen) {
      $.ui.toast("Jumping to Claude's reply needs the fullscreen layout, where the chat scrolls.")

      return {}
    }

    await jumpToReply($)

    return {}
  })

  on('command.run', { command: 'jump' }, async ($, e) => {
    if (!e.presentation.isFullscreen) {
      $.ui.toast('Jumping to a prompt needs the fullscreen layout, where the chat scrolls.')

      return {}
    }

    await openSearch($)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const all = await read($, prompts)
    const typed = await read($, query)
    const found = matching(all, typed)
    const shown = found.slice(0, SHOWN)
    const digits = String(Math.max(0, ...shown.map(prompt => prompt.number))).length

    return (
      <Box flexDirection="column">
        {'Input' in ui && (
          <ui.Input
            key="query"
            value={typed}
            placeholder="Search the prompts you typed"
            submitLabel="jump"
            autoFocus
            onInput={value => update($, query, () => value)}
            onSubmit={value => jumpToFirst($, value)}
          />
        )}
        <Text dimColor>{summaryOf(all.length, found.length, typed)}</Text>
        {'Input' in ui && found.length > 0 && <Text dimColor>Enter jumps to the first, ↓ picks one, Esc closes</Text>}
        <Box flexDirection="column" marginTop={1}>
          {shown.map((prompt, i) => {
            // The first nine take a digit, drawn `1: ` before the label; the
            // rest are indented to line up with them.
            const hotkey = i < 9 ? String(i + 1) : undefined
            const time = prompt.sentAt === undefined ? '' : ` ${timeOf(prompt.sentAt)}`
            const head = `${hotkey === undefined ? '   ' : ''}#${String(prompt.number).padStart(digits)}${time} `
            const room = e.props.bodyColumns - widthOf(head) - (hotkey === undefined ? 0 : 3)
            const { before, match, after } = snippet(prompt.text, typed, Math.max(8, room))
            const parts = [
              <Text dimColor>{head}</Text>,
              before,
              match === '' ? '' : <Text color="suggestion" bold>{match}</Text>,
              after,
            ].filter(part => part !== '')

            return (
              <Button
                key={`prompt-${prompt.id}`}
                plain
                {...(hotkey === undefined ? {} : { hotkey })}
                onPress={() => jump($, prompt)}
              >
                {parts}
              </Button>
            )
          })}
        </Box>
        {found.length > SHOWN && <Text dimColor>{found.length - SHOWN} more: type more to narrow them.</Text>}
      </Box>
    )
  })
}
