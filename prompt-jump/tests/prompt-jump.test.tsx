import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { LIMIT, inConversation, matching, parsePrompts, snippet, timeOf } from '../hooks/prompts'
import type { Prompt } from '../types'

const SESSION = '5e551011-0000-4000-8000-000000000001'
const FILE = `/home/me/.claude/projects/-work-shop/${SESSION}.jsonl`

const PANE = {
  plugin: 'prompt-jump',
  component: 'Pane',
  requestId: 'prompt-jump',
  props: {
    title: 'Jump to a prompt',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// A transcript row of a prompt typed at the terminal.
function typed(uuid: string, content: unknown, timestamp = '2026-10-29T08:05:00.000Z', extra: object = {}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    uuid,
    timestamp,
    origin: { kind: 'human' },
    promptSource: 'typed',
    ...extra,
  })
}

const PASTED = 'Explain this log:\n\n<pasted_content id="ab12">\nERROR timeout in checkout\n</pasted_content id="ab12">\n'

// What grep hands the mod: the typed rows, and rows that carry the same
// origin but are no prompt.
const LINES = [
  typed('p1', 'Fix the checkout total rounding', '2026-10-29T08:05:00.000Z'),
  typed('r1', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
  typed('m1', 'a reminder the person never typed', undefined, { isMeta: true }),
  typed('c1', '<command-name>/jump</command-name>\n<command-message>jump</command-message>'),
  typed('s1', 'a subagent prompt', undefined, { isSidechain: true }),
  typed('p2', [{ type: 'text', text: 'Add a test for the CHECKOUT webhook\nand retry it twice' }, { type: 'image' }], '2026-10-29T08:10:00.000Z'),
  typed('p3', PASTED, '2026-10-29T08:15:00.000Z'),
  JSON.stringify({ type: 'user', uuid: 'n1', message: { content: 'from a peer' }, origin: { kind: 'peer' } }),
  typed('p4', 'Fix the checkout total rounding', '2026-10-29T08:20:00.000Z'),
  '{"type":"user","uuid":"cut',
]

// A row of the conversation as $.session.messages() reads it.
function said(role: 'user' | 'assistant', text: string) {
  return { role, text, toolUses: [] }
}

const CONVERSATION = [
  said('user', 'Fix the checkout total rounding'),
  said('assistant', 'Done.'),
  said('user', 'Add a test for the CHECKOUT webhook\nand retry it twice'),
  said('user', PASTED),
  said('user', 'Fix the checkout total rounding'),
]

function prompt(number: number, text: string): Prompt {
  return { id: `p${number}`, number, text }
}

describe('reading the transcript', () => {
  test('keeps the prompts the person typed, numbered in order, with when they were sent', () => {
    const prompts = parsePrompts(LINES.join('\n'))

    expect(prompts.map(one => [one.id, one.number])).toEqual([
      ['p1', 1],
      ['p2', 2],
      ['p3', 3],
      ['p4', 4],
    ])
    expect(prompts[0]?.sentAt).toBe(Date.parse('2026-10-29T08:05:00.000Z'))
    expect(prompts[1]?.text).toBe('Add a test for the CHECKOUT webhook\nand retry it twice')
  })

  test('keeps only the prompts the conversation still holds', () => {
    const prompts = [prompt(1, 'before the compaction'), prompt(2, 'after it'), prompt(3, 'and again')]
    const rows = [
      { role: 'user', text: 'This session is being continued from a previous conversation...' },
      { role: 'user', text: 'after it' },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: 'and   again' },
    ]

    expect(inConversation(prompts, rows).map(one => one.number)).toEqual([2, 3])
  })

  test('of two prompts with one text, keeps the newer when the conversation holds one', () => {
    const prompts = [prompt(1, 'retry'), prompt(2, 'something else'), prompt(3, 'retry')]

    expect(inConversation(prompts, [{ role: 'user', text: 'retry' }]).map(one => one.number)).toEqual([3])
  })

  test('keeps the older prompts too once the conversation is longer than it reads', () => {
    const prompts = [prompt(1, 'early'), prompt(2, 'late')]
    const rows = Array.from({ length: LIMIT }, (_, i) => ({ role: 'assistant', text: `step ${i}` }))
    rows[LIMIT - 1] = { role: 'user', text: 'late' }

    expect(inConversation(prompts, rows).map(one => one.number)).toEqual([1, 2])
  })
})

describe('matching', () => {
  const prompts = parsePrompts(LINES.join('\n'))

  test('a prompt matches when it holds every word, in any case, newest first', () => {
    expect(matching(prompts, '').map(one => one.number)).toEqual([4, 3, 2, 1])
    expect(matching(prompts, 'checkout').map(one => one.number)).toEqual([4, 3, 2, 1])
    expect(matching(prompts, 'Webhook  checkout').map(one => one.number)).toEqual([2])
    expect(matching(prompts, 'webhook rounding')).toEqual([])
  })

  test("a paste's tags are not searched", () => {
    expect(matching(prompts, 'pasted_content')).toEqual([])
  })

  test('the snippet is the line holding the first word, the word as typed in the prompt', () => {
    expect(snippet('Add a test for the CHECKOUT webhook\nand retry it twice', 'retry', 40)).toEqual({
      before: 'and ',
      match: 'retry',
      after: ' it twice',
    })
    expect(snippet('Add a test for the CHECKOUT webhook', 'checkout', 40)).toEqual({
      before: 'Add a test for the ',
      match: 'CHECKOUT',
      after: ' webhook',
    })
  })

  test('a long line starts near the match and is cut to the width', () => {
    const line = `${'word '.repeat(20)}needle and then more words after it`

    expect(snippet(line, 'needle', 30)).toEqual({ before: '…d word word ', match: 'needle', after: ' and then …' })
    expect(snippet(line, '', 12)).toEqual({ before: 'word word w…', match: '', after: '' })
  })

  test('wide letters take two columns', () => {
    expect(snippet('日本語のプロンプト', '', 9)).toEqual({ before: '日本語の…', match: '', after: '' })
  })
})

// Stands for the engine: a session in /work/shop whose transcript file is
// FILE (or under `folder` when given), grep answering `stdout`, and a record
// of the panes, closes and toasts. The kit has no transcript to scroll, so
// $.ui.scroll on a prompt's row is refused, and the toast that says so names
// the prompt the jump was for.
function engine(on: On, options: { stdout?: string; exitCode?: number; rows?: ReturnType<typeof said>[]; folder?: string } = {}) {
  const file = options.folder === undefined ? FILE : `/home/me/.claude/projects/${options.folder}/${SESSION}.jsonl`
  const seen = {
    opens: [] as unknown[],
    closes: [] as string[],
    toasts: [] as string[],
    runs: [] as (readonly string[])[],
  }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/work/shop' }))
  on('session.root', () => ({ value: '/work/shop' }))
  on('session.messages', () => ({ value: options.rows ?? CONVERSATION }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path === file }))
  on('fs.list', () => ({
    value: ['-other', options.folder ?? '-work-shop'].map(name => ({
      name,
      kind: 'dir' as const,
      size: 0,
      mtimeMs: 0,
      isLink: false,
    })),
  }))
  on('process.run', (_, e) => {
    seen.runs.push(e.argv)

    return {
      value: {
        exitCode: options.exitCode ?? 0,
        stdout: options.stdout ?? `${LINES.join('\n')}\n`,
        stderr: options.exitCode === 2 ? 'grep: Permission denied' : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.open', (_, e) => {
    seen.opens.push(e)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    seen.closes.push(e.id)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })

  return seen
}

async function jump($: Engine, isFullscreen = true) {
  await $.session.start({ cwd: '/work/shop', surface: 'terminal', isInteractive: true })

  return $.command.run({
    command: 'jump',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen, columns: 160 },
  })
}

async function labels(ui: { findAll: (query: { type: 'Button' }) => Promise<{ text?: string }[]> }) {
  return (await ui.findAll({ type: 'Button' })).map(found => found.text)
}

const at = (iso: string) => timeOf(Date.parse(iso))

describe('/jump', () => {
  test('opens the search on the prompts of this chat, newest first', async ($, on) => {
    const seen = engine(on)

    const ran = await jump($)

    expect(ran.text).toBeUndefined()
    expect(seen.runs).toEqual([['/usr/bin/grep', '-F', '"origin":{"kind":"human"}', FILE]])
    expect(seen.opens).toEqual([
      expect.objectContaining({ id: 'prompt-jump', title: 'Jump to a prompt', focus: true, closeOnEscape: true }),
    ])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /newest first/ }))?.text).toBe('4 prompts, newest first')
    expect(await labels(ui)).toEqual([
      `#4 ${at('2026-10-29T08:20:00.000Z')} Fix the checkout total rounding`,
      `#3 ${at('2026-10-29T08:15:00.000Z')} Explain this log:`,
      `#2 ${at('2026-10-29T08:10:00.000Z')} Add a test for the CHECKOUT webhook`,
      `#1 ${at('2026-10-29T08:05:00.000Z')} Fix the checkout total rounding`,
    ])
    await ui.unmount()
  })

  test('typing narrows the list and shows the line that matches', async ($, on) => {
    engine(on)
    await jump($)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'query', text: 'timeout', kind: 'change' })

    expect((await ui.find({ type: 'Text', text: /match/ }))?.text).toBe('1 of 4 prompts match')
    expect(await labels(ui)).toEqual([`#3 ${at('2026-10-29T08:15:00.000Z')} ERROR timeout in checkout`])
    expect((await ui.find({ type: 'Text', text: /^timeout$/ }))?.props.color).toBe('suggestion')

    await ui.input({ key: 'query', text: 'nothing like this', kind: 'change' })
    expect((await ui.find({ type: 'Text', text: /^No prompt/ }))?.text).toBe('No prompt holds "nothing like this"')
    expect(await labels(ui)).toEqual([])
    await ui.unmount()
  })

  test('Enter closes the search and scrolls the chat to the newest match', async ($, on) => {
    const seen = engine(on)
    await jump($)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'query', text: 'rounding' })

    expect(seen.closes).toEqual(['prompt-jump'])
    expect(seen.toasts).toEqual([expect.stringMatching(/^Couldn't scroll to prompt #4: .*ui\.scroll/)])
    await ui.unmount()
  })

  test('pressing a match closes the search and scrolls to it', async ($, on) => {
    const seen = engine(on)
    await jump($)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'prompt-p1' })

    expect(seen.closes).toEqual(['prompt-jump'])
    expect(seen.toasts).toEqual([expect.stringMatching(/^Couldn't scroll to prompt #1: /)])
    await ui.unmount()
  })

  test('Enter with no match leaves the search open', async ($, on) => {
    const seen = engine(on)
    await jump($)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'query', text: 'nothing like this' })

    expect(seen.closes).toEqual([])
    expect(seen.toasts).toEqual([])
    await ui.unmount()
  })

  test('finds the transcript under another project folder', async ($, on) => {
    const seen = engine(on, { folder: '-work-shop-hashed-123' })

    await jump($)

    expect(seen.runs[0]?.[3]).toBe(`/home/me/.claude/projects/-work-shop-hashed-123/${SESSION}.jsonl`)
    expect(seen.opens).toHaveLength(1)
  })

  test('outside the fullscreen layout, says so and opens nothing', async ($, on) => {
    const seen = engine(on)

    await jump($, false)

    expect(seen.toasts).toEqual(['Jumping to a prompt needs the fullscreen layout, where the chat scrolls.'])
    expect(seen.opens).toEqual([])
  })

  test('before the first prompt, says so and opens nothing', async ($, on) => {
    const seen = engine(on, { rows: [] })

    await jump($)

    expect(seen.toasts).toEqual(['No prompts typed in this chat yet.'])
    expect(seen.runs).toEqual([])
    expect(seen.opens).toEqual([])
  })

  test("says so when grep can't read the transcript", async ($, on) => {
    const seen = engine(on, { exitCode: 2, stdout: '' })

    await jump($)

    expect(seen.toasts).toEqual(["Couldn't read this session's transcript: grep: Permission denied"])
    expect(seen.opens).toEqual([])
  })
})
