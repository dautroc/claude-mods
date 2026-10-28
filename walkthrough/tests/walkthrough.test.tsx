import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, PromptComposeTrait, RenderSurface } from 'claude-code'
import type { Engine, Mounted } from 'claude-code/testing'

import type { Review } from '../types'
import { colorsOf, diagramText, pictureBox } from '../hooks/preview'
import { answersMessage, parseReview } from '../hooks/review'

const TOOL = 'mcp__walkthrough__review_items'
const PANE = {
  plugin: 'walkthrough',
  component: 'Pane',
  requestId: 'walkthrough',
  props: {
    title: 'Review',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// A 64×40 PNG, solid blue.
const BLUE =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAAV0lEQVR4nO3PUQkAIBTAwJfEzDbWEH4cwmABbrP2+brhgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAseu0qlwvFxtV31AAAAAElFTkSuQmCC'

const FLOW = 'flowchart LR\n  A[Ask] --> B[Answer]'

const INPUT = {
  title: 'Release plan',
  items: [
    {
      title: 'Cache key',
      body: 'Keyed per session today, so /clear loses it.',
      recommendation: 'Per-root, so worktrees share one.',
      choices: [{ label: 'Per-root key', detail: 'Worktrees share', recommended: true }, { label: 'Per-session key' }],
    },
    { title: 'Checks', choices: [{ label: 'Lint' }, { label: 'Types' }, { label: 'Tests' }], multiSelect: true },
    { title: 'Name', preview: { kind: 'mermaid', source: FLOW } },
  ],
}

type Seen = {
  tools: { name: string; isDeferred?: boolean }[]
  commands: string[]
  opens: unknown[]
  closes: string[]
  toasts: string[]
  runs: { argv: string[]; stdin?: string }[]
  submits: { text: string; asUser?: boolean }[]
  // What render/mermaid.mjs writes, or null for a node that won't start.
  rendered: string | null
  // A refusal of the next submit.
  drop?: string
  isPlaced: boolean
}

// Stands for the engine: a session in a Mado shell (pictures forced on unless
// `shell` says otherwise), the pane placed and focused, the renderer answering
// `seen.rendered`, and a record of what the mod registered, opened, closed,
// toasted, ran and submitted.
function engine(
  on: On,
  rendered: string | null = null,
  shell: Record<string, string> = { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' },
): Seen {
  const seen: Seen = {
    tools: [],
    commands: [],
    opens: [],
    closes: [],
    toasts: [],
    runs: [],
    submits: [],
    rendered,
    isPlaced: true,
  }
  mock.env(on, { TMPDIR: '/tmp/t/', HOME: '/home/me', ...shell })
  on('tool.register', (_, e) => {
    seen.tools.push({ name: e.name, isDeferred: e.isDeferred })

    return { value: { tool: `mcp__walkthrough__${e.name}` } }
  })
  on('command.register', (_, e) => {
    seen.commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'abcdef1234' }))
  on('config.list', () => ({ value: [] }))
  on('ui.open', (_, e) => {
    seen.opens.push(e)

    return { value: seen.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'too narrow' } }
  })
  on('ui.panes', () => ({
    value: [{ id: 'walkthrough', title: 'Review', isShown: true, isFocused: true, isPlaced: true }],
  }))
  on('ui.close', (_, e) => {
    seen.closes.push(e.id)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(String(e.text))

    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    const asUser = (e.origin as { asUser?: boolean } | undefined)?.asUser
    seen.submits.push({ text: e.text, ...(asUser === undefined ? {} : { asUser }) })
    if (seen.drop !== undefined) {
      return { drop: seen.drop }
    }

    return { text: e.text }
  })
  on('process.run', (_, e) => {
    seen.runs.push({ argv: [...e.argv], ...(e.init?.stdin === undefined ? {} : { stdin: e.init.stdin }) })
    if (e.argv[0] === 'node' && seen.rendered === null) {
      return { deny: 'spawn node ENOENT' }
    }

    return {
      value: { exitCode: 0, stdout: seen.rendered ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('fs.read', (_, e) =>
    e.path === '/tmp/t/claude-walkthrough/abcdef12/r/2.png' ? { value: { base64: BLUE } } : { deny: `${e.path}: ENOENT` },
  )

  return seen
}

const DRAWN = JSON.stringify({
  diagrams: [
    {
      key: '2',
      text: '┌─────┐     ┌────────┐\n│ Ask ├────►│ Answer │\n└─────┘     └────────┘\n',
      png: '/tmp/t/claude-walkthrough/abcdef12/r/2.png',
      width: 640,
      height: 160,
    },
  ],
})

async function start($: Engine) {
  await $.session.start({ cwd: '/work/shop', surface: 'terminal', isInteractive: true })
}

function call($: Engine, input: Record<string, unknown> = INPUT) {
  return $.tool.call({ tool: TOOL, ...input })
}

async function command($: Engine, name: string) {
  return $.command.run({
    command: name,
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
}

async function texts(ui: Pick<Mounted, 'findAll'>) {
  return (await ui.findAll({ type: 'Text' })).map(found => found.text)
}

async function labels(ui: Pick<Mounted, 'findAll'>) {
  return (await ui.findAll({ type: 'Button' })).map(found => String(found.props.key))
}

describe('the helpers', () => {
  test('parse a review, saying what is wrong with a bad one', () => {
    const review = parseReview(INPUT, 'r')
    expect(review.items.map(item => item.title)).toEqual(['Cache key', 'Checks', 'Name'])
    expect(review.items[1]?.multiSelect).toBe(true)
    expect(review.answers).toEqual([
      { picked: [], note: '' },
      { picked: [], note: '' },
      { picked: [], note: '' },
    ])
    expect(() => parseReview({ title: 'x', items: [] }, 'r')).toThrow(/1 to 20 items/)
    expect(() => parseReview({ title: 'x', items: [{ title: ' ' }] }, 'r')).toThrow(/items\[0\]\.title/)
    expect(() => parseReview({ title: 'x', items: [{ title: 'a', preview: { kind: 'svg', source: 'x' } }] }, 'r')).toThrow(
      /kind must be one of mermaid, markdown, code, diff/,
    )
  })

  test('write the answers as one line per item', () => {
    const review: Review = {
      ...parseReview(INPUT, 'r'),
      answers: [
        { picked: [0], note: 'only for v1' },
        { picked: [], note: 'none, CI does it' },
        { picked: [], note: '' },
      ],
    }

    expect(answersMessage(review)).toBe(
      [
        'Review answers · Release plan',
        '',
        '1. Cache key: Per-root key (recommended). Note: only for v1',
        '2. Checks: none of the choices: none, CI does it',
        '3. Name: skipped',
      ].join('\n'),
    )
  })

  test('size a picture to the pane, and pick the text that fits', () => {
    expect(pictureBox(640, 160, 60, 20)).toEqual({ columns: 40, rows: 5 })
    expect(pictureBox(3200, 400, 60, 20)).toEqual({ columns: 60, rows: 4 })
    expect(pictureBox(400, 1600, 60, 10)).toEqual({ columns: 5, rows: 10 })
    const wide = { text: 'x'.repeat(80), narrow: 'y'.repeat(30) }
    expect(diagramText(wide, 60)).toBe('y'.repeat(30))
    expect(diagramText(wide, 90)).toBe('x'.repeat(80))
  })

  test("take a custom theme's colours from its file", () => {
    expect(colorsOf('custom:mado', { base: 'light', overrides: { inverseText: '#dcd9ce', text: '#42403d' } })).toEqual({
      bg: '#dcd9ce',
      fg: '#42403d',
    })
    expect(colorsOf('light-daltonized')).toEqual({ bg: '#ffffff', fg: '#27272a' })
    expect(colorsOf('dark')).toEqual({ bg: '#1e1e1e', fg: '#e4e4e7' })
  })
})

describe('the tool', () => {
  test('is registered with its schema in the prompt, beside /walk', async ($, on) => {
    const seen = engine(on)
    await start($)

    expect(seen.tools).toEqual([{ name: 'review_items', isDeferred: false }])
    expect(seen.commands).toEqual(['walk'])
  })

  test('is left out under -p and the SDK, where nobody could answer', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/work/shop', surface: null, isInteractive: false })

    expect(seen.tools).toEqual([])
    expect(seen.commands).toEqual([])
  })

  function facts(tools: string[], surfaces: RenderSurface[], traits: PromptComposeTrait[]) {
    const model = 'claude-haiku-5-5'

    return { model, promptModel: model, surfaces, tools, outputStyle: null, traits }
  }

  test('has a rule last in the system prompt where it is listed and something draws', async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))

    const { sections } = await $.prompt.compose(facts([TOOL], ['terminal'], []))
    expect(sections.map(section => [section.id, section.scope])).toEqual([
      ['intro', 'shared'],
      ['walkthrough:review', 'session'],
    ])
    expect(sections[1]!.text).toContain(`don't write the items out: call ${TOOL}`)

    for (const [tools, surfaces, traits] of [
      [[], ['terminal'], []],
      [[TOOL], [], ['print']],
      [[TOOL], ['terminal'], ['bare']],
    ] as const) {
      const { sections: left } = await $.prompt.compose(facts([...tools], [...surfaces], [...traits]))
      expect(left.map(section => section.id)).toEqual(['intro'])
    }
  })

  test('opens the pane with the keyboard and tells Claude to end its turn', async ($, on) => {
    const seen = engine(on, DRAWN)
    await start($)

    const opened = await call($)

    expect(opened.deny).toBeUndefined()
    expect(String(opened.result)).toMatch(/^The person has the review "Release plan" \(3 items\) in the walkthrough pane/)
    expect(String(opened.result)).toMatch(/end your turn now with one short line/)
    expect(seen.opens).toEqual([expect.objectContaining({ id: 'walkthrough', focus: true })])
    expect(seen.toasts).toEqual([])
  })

  test('draws the diagrams with node in the theme colours, under the session temp folder', async ($, on) => {
    const seen = engine(on, DRAWN)
    await start($)

    await call($)

    const run = seen.runs.find(each => each.argv[0] === 'node')
    expect(run?.argv[1]).toMatch(/\/render\/mermaid\.mjs$/)
    const request = JSON.parse(run?.stdin ?? '{}')
    expect(request.out).toMatch(/^\/tmp\/t\/claude-walkthrough\/abcdef12\/[0-9a-f]{8}$/)
    expect(request.colors).toEqual({ bg: '#1e1e1e', fg: '#e4e4e7' })
    expect(request.diagrams).toEqual([{ key: '2', source: FLOW }])
  })

  test("says which diagrams couldn't be drawn", async ($, on) => {
    const seen = engine(on, JSON.stringify({ diagrams: [{ key: '2', error: 'Invalid mermaid header: "pie"' }] }))
    await start($)

    const opened = await call($)

    expect(String(opened.result)).toMatch(/The diagram of item 3 could not be drawn \(Invalid mermaid header: "pie"\)/)
    seen.rendered = null
    const again = await call($)
    expect(String(again.result)).toMatch(/item 3 could not be drawn \(node could not run: .*ENOENT\)/)
    expect(String(again.result)).toMatch(/It replaces the review "Release plan", which they had not sent/)
  })

  test('refuses an input it cannot show, saying why', async ($, on) => {
    const seen = engine(on)
    await start($)

    const refused = await call($, { title: 'x', items: [{ title: 'a', choices: Array(10).fill({ label: 'c' }) }] })

    expect(refused.deny).toMatch(/at most 9 choices/)
    expect(seen.opens).toEqual([])
  })

  test('says to use /walk when the pane could not be placed', async ($, on) => {
    const seen = engine(on)
    seen.isPlaced = false
    await start($)

    const opened = await call($, { title: 'x', items: [{ title: 'a' }] })

    expect(String(opened.result)).toMatch(/the person opens it with \/walk/)
    expect(seen.toasts).toEqual(['Claude has items for you to review: /walk opens them.'])
  })
})

describe('the pane', () => {
  test('shows one item: its title, body, recommendation and choices, the recommended one focused', async ($, on) => {
    engine(on, DRAWN)
    await start($)
    await call($)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const shown = await texts(ui)
    expect(shown).toContain('Release plan')
    expect(shown).toContain('1 / 3')
    expect(shown).toContain('Cache key')
    expect(shown).toContain('★ Recommended: ')
    expect(shown).toContain('Worktrees share')
    expect(await labels(ui)).toEqual(['choice-0', 'choice-1', 'key-n', 'key-w', 'key-s'])
    expect((await ui.find({ key: 'choice-0' }))?.props.autoFocus).toBe(true)
    expect((await ui.find({ key: 'choice-1' }))?.props.hotkey).toBe('2')
    await ui.unmount()
  })

  test('walks the items to the summary and sends the answers as the next message', async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on, DRAWN)
    await start($)
    await call($)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'choice-0' })
    expect(await texts(ui)).toContain('2 / 3')
    await ui.press({ key: 'choice-0' })
    await ui.press({ key: 'choice-2' })
    expect(await texts(ui)).toContain('[x] ')
    await ui.press({ key: 'key-n' })
    expect(await texts(ui)).toContain('3 / 3')
    await ui.input({ key: 'note', text: 'walkthrough' })
    expect(await texts(ui)).toContain('3 of 3 answered')
    await ui.press({ key: 'send' })
    await clock.advance(1)

    expect(seen.closes).toEqual(['walkthrough'])
    expect(seen.submits).toEqual([
      {
        text: ['Review answers · Release plan', '', '1. Cache key: Per-root key (recommended)', '2. Checks: Lint, Tests', '3. Name: walkthrough'].join('\n'),
        asUser: true,
      },
    ])
    await ui.unmount()

    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await texts(after))[0]).toMatch(/^No review is open/)
    await after.unmount()
  })

  test('the summary marks what was skipped, and a digit goes back to change it', async ($, on) => {
    engine(on, DRAWN)
    await start($)
    await call($)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'key-s' })
    expect(await texts(ui)).toEqual(expect.arrayContaining(['0 of 3 answered', '· skipped', 'Unanswered items are sent as skipped.']))
    expect((await ui.find({ key: 'item-1' }))?.props.hotkey).toBe('2')
    await ui.press({ key: 'item-1' })
    expect(await texts(ui)).toContain('2 / 3')
    await ui.unmount()
  })

  test('a refused send puts the review back and says so', async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on)
    seen.drop = 'a Stop hook blocked it'
    await start($)
    await call($, { title: 'x', items: [{ title: 'a' }] })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'key-s' })
    await ui.press({ key: 'send' })
    await clock.advance(1)

    expect(seen.toasts).toEqual(["Couldn't send your answers (a Stop hook blocked it). /walk opens the review again."])
    expect(await texts(ui)).toContain('0 of 1 answered')
    await ui.unmount()
  })

  test('shows a diagram as a picture on the terminal, t switching to text and source', async ($, on) => {
    engine(on, DRAWN)
    await start($)
    await call($)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'key-n' })
    await ui.press({ key: 'key-n' })
    const image = await ui.find({ key: 'diagram' })
    expect(image?.props.source).toEqual({ png: BLUE })
    expect(image?.props.columns).toBe(40)
    expect(image?.props.rows).toBe(5)
    expect(await ui.find({ key: 'key-v' })).toBeDefined()

    await ui.press({ key: 'key-t' })
    expect(await ui.find({ key: 'diagram' })).toBeUndefined()
    expect(await texts(ui)).toContain('│ Ask ├────►│ Answer │')
    await ui.press({ key: 'key-t' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe(FLOW)
    await ui.unmount()
  })

  test('starts on the text where the terminal likely draws no pictures, t still reaching the picture', async ($, on) => {
    engine(on, DRAWN, { TERM_PROGRAM: 'Apple_Terminal' })
    await start($)
    await call($)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'key-s' })
    await ui.press({ key: 'item-2' })
    expect(await ui.find({ key: 'diagram' })).toBeUndefined()
    expect(await texts(ui)).toContain('│ Ask ├────►│ Answer │')
    await ui.press({ key: 'key-t' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe(FLOW)
    await ui.press({ key: 'key-t' })
    expect((await ui.find({ key: 'diagram' }))?.props.source).toEqual({ png: BLUE })
    await ui.unmount()
  })

  test('shows the source and why where a diagram could not be drawn', async ($, on) => {
    engine(on)
    await start($)
    await call($)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'key-s' })
    await ui.press({ key: 'item-2' })
    expect(await texts(ui)).toEqual(expect.arrayContaining([expect.stringMatching(/^Couldn't draw the diagram: node could not run/)]))
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe(FLOW)
    expect(await ui.find({ key: 'key-t' })).toBeUndefined()
    await ui.unmount()
  })

  test('draws on every surface, the text version where there is no picture', async ($, on) => {
    engine(on, DRAWN)
    await start($)
    await call($)

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await texts(ui)).toContain('Cache key')
      expect((await ui.find({ key: 'note' })) === undefined).toBe(surface === 'mobile')
      expect((await ui.find({ key: 'key-w' })) === undefined).toBe(surface === 'mobile')
      await ui.unmount()
    }

    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await desktop.press({ key: 'key-s' })
    await desktop.press({ key: 'item-2' })
    expect(await desktop.find({ key: 'diagram' })).toBeUndefined()
    expect(await desktop.find({ key: 'key-v' })).toBeUndefined()
    expect(await texts(desktop)).toContain('│ Ask ├────►│ Answer │')
    await desktop.unmount()
  })
})

describe('/walk and the transcript', () => {
  test('/walk opens the open review, or says there is none', async ($, on) => {
    const seen = engine(on)
    await start($)

    await command($, 'walk')
    expect(seen.toasts).toEqual(['No review is open. Claude opens one when it has items for you to decide.'])
    expect(seen.opens).toEqual([])

    await call($, { title: 'x', items: [{ title: 'a' }] })
    await command($, 'walk')
    expect(seen.opens).toHaveLength(2)
  })

  test('/clear drops the review', async ($, on) => {
    const seen = engine(on)
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    await start($)
    await call($, { title: 'x', items: [{ title: 'a' }] })

    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await command($, 'walk')

    expect(seen.toasts.at(-1)).toMatch(/^No review is open/)
  })

  test("the call's row lists the items, with an open button while it is the open review", async ($, on) => {
    engine(on)
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine</Text>
    })
    await start($)
    const props = {
      tool_use_id: 'toolu_1',
      tool: TOOL,
      input: INPUT,
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    }

    const row = await $.ui.mount({ plugin: 'walkthrough', component: 'ToolUse', requestId: 'toolu_1', props, surface: 'terminal' })
    expect(await texts(row)).toEqual(['⏺', 'Review', 'Release plan', '· 3 items', '  ⎿  1. Cache key', '     2. Checks', '     3. Name'])
    expect(await row.find({ key: 'open' })).toBeUndefined()
    await row.unmount()

    const expanded = await $.ui.mount({
      plugin: 'walkthrough',
      component: 'ToolUse',
      requestId: 'toolu_1',
      props: { ...props, isExpanded: true },
      surface: 'terminal',
    })
    expect(await texts(expanded)).toEqual(['engine'])
    await expanded.unmount()
  })
})
