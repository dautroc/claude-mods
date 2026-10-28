import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptComposeTrait, RenderSurface } from 'claude-code'

import { inline, parse, widthOf, wrap } from '../hooks/markdown'

// What the engine draws for a row when the mod passes.
function engine(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

// Stands for the engine's clipboard, toasts and session rows, and records
// what was copied and said.
function clipboard(on: On, messages: { role: 'user' | 'assistant'; text: string }[] = []) {
  const seen = { copies: [] as string[], toasts: [] as string[] }
  on('ui.copy', (_, e) => {
    seen.copies.push(e.text)

    return { value: { isCopied: true } }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(String(e.text))

    return { value: undefined }
  })
  on('session.messages', () => ({ value: messages.map(m => ({ ...m, toolUses: [] })) }))

  return seen
}

function reply(text: string, columns = 100) {
  return {
    plugin: 'reply-style',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true },
    viewport: { columns, rows: 40 },
  } as const
}

type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }

// What a drawn element reads as: its strings, a link's text and not its URL.
function textOf(node: unknown): string {
  if (typeof node === 'string') return node

  return ((node as Node).children ?? []).map(textOf).join('')
}

// Each outermost Text in a drawing, as it reads.
function rows(node: unknown): string[] {
  if (typeof node !== 'object' || node === null) return []
  const element = node as Node

  return element.type === 'Text' ? [textOf(element)] : (element.children ?? []).flatMap(rows)
}

async function lines($: Engine, text: string, columns = 100): Promise<string[]> {
  const ui = await $.ui.mount({ ...reply(text, columns), surface: 'terminal' })
  const drawn = rows(await ui.drawn())
  await ui.unmount()

  return drawn
}

function runCommand($: Engine, args: string) {
  return $.command.run({
    command: 'reply-style',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
}

describe('reading markdown', () => {
  test('reads headings, rules, fences and paragraphs', () => {
    expect(parse('# Title\n\nOne\ntwo\n\n---\n\n```ts\nconst a = 1\n```')).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'paragraph', text: 'One two' },
      { kind: 'rule' },
      { kind: 'code', lang: 'ts', source: 'const a = 1' },
    ])
  })

  test('keeps a command output’s line breaks', () => {
    expect(parse('a\n  b', 'line')).toEqual([{ kind: 'paragraph', text: 'a\n  b' }])
  })

  test('draws a fence still streaming as code', () => {
    expect(parse('Run:\n```bash\nmake test')).toEqual([
      { kind: 'paragraph', text: 'Run:' },
      { kind: 'code', lang: 'bash', source: 'make test' },
    ])
  })

  test('reads a copy fence as text to copy, under its label', () => {
    expect(parse('Draft:\n\n```copy Slack reply to Hana\nHi *Hana*,\n\n  done.\n```\n\n```copy\nplain\n```')).toEqual([
      { kind: 'paragraph', text: 'Draft:' },
      { kind: 'copy', label: 'Slack reply to Hana', text: 'Hi *Hana*,\n\n  done.' },
      { kind: 'copy', label: '', text: 'plain' },
    ])
  })

  test('keeps a fence inside a copy fence opened with more backticks or tildes', () => {
    const inner = 'Run:\n```sh\nmake test\n```'
    expect(parse(`\`\`\`\`copy PR comment\n${inner}\n\`\`\`\``)).toEqual([
      { kind: 'copy', label: 'PR comment', text: inner },
    ])
    expect(parse(`~~~copy PR comment\n${inner}\n~~~`)).toEqual([{ kind: 'copy', label: 'PR comment', text: inner }])
  })

  test('nests a list under an ordered item indented less than its text', () => {
    expect(parse('1. Build\n  - tests\n  - lint\n2. Ship')).toEqual([
      {
        kind: 'list',
        start: 1,
        items: [
          {
            blocks: [
              { kind: 'paragraph', text: 'Build' },
              {
                kind: 'list',
                items: [{ blocks: [{ kind: 'paragraph', text: 'tests' }] }, { blocks: [{ kind: 'paragraph', text: 'lint' }] }],
              },
            ],
          },
          { blocks: [{ kind: 'paragraph', text: 'Ship' }] },
        ],
      },
    ])
  })

  test('reads task items and keeps a code block inside an item', () => {
    expect(parse('- [x] done\n- [ ] todo\n\n  ```sh\n  ls\n  ```')).toEqual([
      {
        kind: 'list',
        items: [
          { task: 'done', blocks: [{ kind: 'paragraph', text: 'done' }] },
          {
            task: 'todo',
            blocks: [
              { kind: 'paragraph', text: 'todo' },
              { kind: 'code', lang: 'sh', source: 'ls' },
            ],
          },
        ],
      },
    ])
  })

  test('reads quotes and GitHub alerts', () => {
    expect(parse('> [!WARNING]\n> Careful\n\n> plain')).toEqual([
      { kind: 'quote', alert: 'warning', blocks: [{ kind: 'paragraph', text: 'Careful' }] },
      { kind: 'quote', blocks: [{ kind: 'paragraph', text: 'plain' }] },
    ])
  })

  test('reads a table with alignment, escaped pipes and short rows', () => {
    expect(parse('Files:\n| a | b | c |\n|:--|:-:|--:|\n| x \\| y | 2 |')).toEqual([
      { kind: 'paragraph', text: 'Files:' },
      { kind: 'table', head: ['a', 'b', 'c'], align: ['left', 'center', 'right'], rows: [['x | y', '2', '']] },
    ])
  })

  test('styles inline text, and finds numbers and paths in what is plain', () => {
    expect(inline('**Bold *both*** and `x_1` see [docs](https://a.dev) at ~/src/app.ts, 250ms or v2.1.0')).toEqual([
      { text: 'Bold ', bold: true },
      { text: 'both', bold: true, italic: true },
      { text: ' and ' },
      { text: 'x_1', code: true },
      { text: ' see ' },
      { text: 'docs', href: 'https://a.dev' },
      { text: ' at ' },
      { text: '~/src/app.ts', path: true },
      { text: ', ' },
      { text: '250ms', number: true },
      { text: ' or ' },
      { text: 'v2.1.0', number: true },
    ])
  })

  test('leaves snake_case, x86, /config and a lone star as written', () => {
    expect(inline('snake_case_name on x86 runs /config, 2 * 3')).toEqual([
      { text: 'snake_case_name on x86 runs /config, ' },
      { text: '2', number: true },
      { text: ' * ' },
      { text: '3', number: true },
    ])
  })

  test('links a bare URL without the punctuation after it', () => {
    expect(inline('See https://example.com/a_(b).')).toEqual([
      { text: 'See ' },
      { text: 'https://example.com/a_(b)', href: 'https://example.com/a_(b)' },
      { text: '.' },
    ])
  })

  test('counts wide letters twice and wraps them inside a word', () => {
    expect(widthOf('日本語 ok')).toBe(9)
    expect(wrap([{ text: '日本語のテキスト' }], 6).map(line => line.map(run => run.text).join(''))).toEqual([
      '日本語',
      'のテキ',
      'スト',
    ])
    expect(wrap([{ text: 'one two ' }, { text: 'three', bold: true }], 8)).toEqual([
      [{ text: 'one two' }],
      [{ text: 'three', bold: true }],
    ])
  })
})

describe('a reply on the terminal', () => {
  test('opens with the reply bullet and a blank line above it', async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...reply('Hello'), surface: 'terminal' })
    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { marginTop: 1 } })
    expect((await ui.find({ type: 'Text', text: '⏺' }))?.props.color).toBe('text')
    await ui.unmount()
  })

  test('draws H1 and H2 in the accent colour, H1 with a rule as wide as it', async ($, on) => {
    engine(on)
    expect(await lines($, '# Plan\n\n## Steps\n\n### Notes')).toEqual(['⏺', 'Plan', '━━━━', 'Steps', 'Notes'])

    const ui = await $.ui.mount({ ...reply('## Steps'), surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /^Steps$/ }))?.children).toMatchObject([
      { props: { color: 'claude', bold: true } },
    ])
    await ui.unmount()
  })

  test('boxes a table, aligning its columns and fitting wide letters', async ($, on) => {
    engine(on)
    const table = '| Name | Size |\n|:-----|-----:|\n| a.ts | 12 |\n| 長い名前 | 3 |'
    expect(await lines($, table)).toEqual([
      '⏺',
      '╭──────────┬──────╮',
      '│ Name     │ Size │',
      '├──────────┼──────┤',
      '│ a.ts     │   12 │',
      '│ 長い名前 │    3 │',
      '╰──────────┴──────╯',
    ])
  })

  test('wraps a table too wide for the terminal, with rules between its rows', async ($, on) => {
    engine(on)
    const table = '| Step | What happens |\n|---|---|\n| 1 | The mod reads the reply |\n| 2 | It draws it |'
    expect(await lines($, table, 26)).toEqual([
      '⏺',
      '╭──────┬───────────────╮',
      '│ Step │ What happens  │',
      '├──────┼───────────────┤',
      '│ 1    │ The mod reads │',
      '│      │ the reply     │',
      '├──────┼───────────────┤',
      '│ 2    │ It draws it   │',
      '╰──────┴───────────────╯',
    ])
  })

  test('marks list items, numbers them and ticks done tasks', async ($, on) => {
    engine(on)
    expect(await lines($, '- one\n  - inner\n\n1. first\n2. second\n\n- [x] shipped\n- [ ] tested')).toEqual([
      '⏺',
      '•',
      'one',
      '◦',
      'inner',
      '1.',
      'first',
      '2.',
      'second',
      '[✓]',
      'shipped',
      '[ ]',
      'tested',
    ])

    const ui = await $.ui.mount({ ...reply('- [x] shipped'), surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /^shipped$/ }))?.children).toMatchObject([
      { props: { strikethrough: true, dimColor: true } },
    ])
    await ui.unmount()
  })

  test('frames an alert in its colour under its name', async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...reply('> [!TIP]\n> Use make test'), surface: 'terminal' })
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.filter(b => b.props.borderStyle !== undefined).map(b => b.props)).toEqual([
      { flexDirection: 'column', alignSelf: 'flex-start', borderStyle: 'round', borderColor: 'success', paddingX: 1 },
    ])
    expect((await ui.find({ type: 'Text', text: /^Tip$/ }))?.props).toEqual({ bold: true, color: 'success' })
    await ui.unmount()
  })

  test('colours inline code, links, numbers and paths', async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({
      ...reply('Run `make` on ~/a.md in 3s, see [docs](https://a.dev) or https://b.dev'),
      surface: 'terminal',
    })
    const colors = Object.fromEntries(
      (await ui.findAll({ type: 'Text' })).filter(t => t.props.color !== undefined).map(t => [textOf(t), t.props.color]),
    )
    expect(colors).toEqual({
      '⏺': 'text',
      make: 'permission',
      '~/a.md': 'success',
      '3s': 'merged',
      docs: 'ide',
      'https://b.dev': 'ide',
    })
    await ui.unmount()
  })

  test('makes a labelled web link clickable and leaves a bare address to the terminal', async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...reply('See [docs](https://a.dev) or https://b.dev'), surface: 'terminal' })
    expect((await ui.findAll({ type: 'Link' })).map(link => [link.props, textOf(link)])).toEqual([
      [{ href: 'https://a.dev' }, 'docs'],
    ])
    await ui.unmount()
  })

  test('shows a link that is not a web address beside its text, unclickable', async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...reply('Open [the notes](file:///tmp/run.command)'), surface: 'terminal' })
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'the notes (file:///tmp/run.command)' })).toBeDefined()
    await ui.unmount()
  })

  test('draws a code block with the engine’s highlighter and copies it from its button', async ($, on) => {
    engine(on)
    const seen = clipboard(on)
    const ui = await $.ui.mount({ ...reply('Two:\n\n```ts\nconst a = 1\n```\n\n```\nplain\n```'), surface: 'terminal' })
    expect((await ui.findAll({ type: 'Code' })).map(code => code.props)).toEqual([
      { source: 'const a = 1', language: 'ts' },
      { source: 'plain' },
    ])
    expect((await ui.findAll({ type: 'Text', text: /^(ts|text)$/ })).map(t => t.text)).toEqual(['ts', 'text'])

    await ui.press({ key: 'copy-1' })
    expect(seen.copies).toEqual(['plain'])
    expect(seen.toasts).toEqual(['Copied the code block.'])
    await ui.unmount()
  })
})

describe('text to copy on the terminal', () => {
  const draft = 'Here it is:\n\n```ts\nconst a = 1\n```\n\n```copy Slack reply to Hana\nHi **Hana**,\n\nthe deploy is done.\n```'

  test('draws the text as written under its label and a copy button', async ($, on) => {
    engine(on)
    expect(await lines($, draft)).toEqual([
      '⏺',
      'Here it is:',
      'ts',
      'Slack reply to Hana',
      'Hi **Hana**,',
      ' ',
      'the deploy is done.',
    ])
  })

  test('copies exactly the text from its button, counted with the code blocks', async ($, on) => {
    engine(on)
    const seen = clipboard(on)
    const ui = await $.ui.mount({ ...reply(draft), surface: 'terminal' })
    await ui.press({ key: 'copy-1' })
    expect(seen.copies).toEqual(['Hi **Hana**,\n\nthe deploy is done.'])
    expect(seen.toasts).toEqual(['Copied “Slack reply to Hana”.'])
    await ui.unmount()
  })

  test('labels text with no label as text', async ($, on) => {
    engine(on)
    const seen = clipboard(on)
    const ui = await $.ui.mount({ ...reply('```copy\nplain\n```'), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'text' })).toBeDefined()
    await ui.press({ key: 'copy-0' })
    expect(seen.toasts).toEqual(['Copied the text.'])
    await ui.unmount()
  })
})

describe('the rule that teaches the model the copy fence', () => {
  // The engine's own sections, beneath the mod.
  function sections(on: On) {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  }

  function facts(surfaces: RenderSurface[], traits: PromptComposeTrait[]) {
    const model = 'claude-haiku-5-5'

    return { model, promptModel: model, surfaces, tools: [], outputStyle: null, traits }
  }

  test('goes last in the system prompt of a session that draws', async ($, on) => {
    sections(on)
    const { sections: out } = await $.prompt.compose(facts(['terminal'], []))
    expect(out.map(section => [section.id, section.scope])).toEqual([
      ['intro', 'shared'],
      ['reply-style:copy', 'session'],
    ])
    expect(out[1]!.text).toContain('```copy Slack reply to Hana')
  })

  for (const [name, surfaces, traits] of [
    ['under -p', [], ['print']],
    ['with nothing drawing', [], []],
    ['under --bare', ['terminal'], ['bare']],
  ] as const) {
    test(`is left out ${name}`, async ($, on) => {
      sections(on)
      const { sections: out } = await $.prompt.compose(facts([...surfaces], [...traits]))
      expect(out.map(section => section.id)).toEqual(['intro'])
    })
  }
})

describe('what the mod leaves to the engine', () => {
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    test(`a reply in the ${surface} app`, async ($, on) => {
      engine(on)
      const ui = await $.ui.mount({ ...reply('# Title'), surface })
      expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
      await ui.unmount()
    })
  }

  test('a summary of the model’s text, which the engine marks', async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({
      ...reply('# Title'),
      props: { text: '# Title', isFirstOfReply: true, isSummary: true },
      surface: 'terminal',
    })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  })
})

describe('slash-command output', () => {
  function output(text: string, isErrored = false) {
    return {
      plugin: 'reply-style',
      component: 'CommandOutput',
      surface: 'terminal',
      props: { command: 'context', args: '', text, isErrored },
      viewport: { columns: 80, rows: 40 },
    } as const
  }

  test('draws markdown output under the output mark', async ($, on) => {
    engine(on)
    const ui = await $.ui.mount(output('## Usage\n\n| Kind | Tokens |\n|---|---:|\n| tools | 1.2k |'))
    expect(rows(await ui.drawn())).toEqual([
      '  ⎿  ',
      'Usage',
      '╭───────┬────────╮',
      '│ Kind  │ Tokens │',
      '├───────┼────────┤',
      '│ tools │   1.2k │',
      '╰───────┴────────╯',
    ])
    expect((await ui.find({ type: 'Text', text: /^1\.2k$/ }))?.props).toEqual({ color: 'merged' })
    await ui.unmount()
  })

  for (const [name, text, isErrored] of [
    ['plain lines laid out by hand', 'Total cost:  $0.12\nDuration:    3s', false],
    ['an error', '## Failed', true],
    ['coloured output', '\u001b[31m# red\u001b[0m', false],
  ] as const) {
    test(`leaves ${name} to the engine`, async ($, on) => {
      engine(on)
      const ui = await $.ui.mount(output(text, isErrored))
      expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
      await ui.unmount()
    })
  }
})

describe('/reply-style copy', () => {
  const messages = [
    { role: 'user', text: 'How?' },
    { role: 'assistant', text: 'Like this:\n\n- step\n\n  ```sh\n  make test\n  ```' },
    { role: 'user', text: 'Thanks' },
  ] as const

  test('copies the last reply', async ($, on) => {
    const seen = clipboard(on, [...messages])
    expect(await runCommand($, 'copy')).toEqual({})
    expect(seen.copies).toEqual([messages[1].text])
    expect(seen.toasts).toEqual(['Copied the last reply.'])
  })

  test('with code, copies the last code block in it, inside a list too', async ($, on) => {
    const seen = clipboard(on, [...messages])
    await runCommand($, 'copy code')
    expect(seen.copies).toEqual(['make test'])
    expect(seen.toasts).toEqual(['Copied the last code block.'])
  })

  test('with draft, copies the last draft in it under its label', async ($, on) => {
    const seen = clipboard(on, [
      { role: 'user', text: 'Draft both' },
      {
        role: 'assistant',
        text: '```copy Email subject\nDeploy done\n```\n\n```sh\nmake deploy\n```\n\n```copy Email to Hana\nHi Hana,\n\ndone.\n```',
      },
    ])
    await runCommand($, 'copy draft')
    expect(seen.copies).toEqual(['Hi Hana,\n\ndone.'])
    expect(seen.toasts).toEqual(['Copied “Email to Hana”.'])
  })

  test('says so when the last reply has no draft', async ($, on) => {
    const seen = clipboard(on, [...messages])
    await runCommand($, 'copy draft')
    expect(seen.copies).toEqual([])
    expect(seen.toasts).toEqual(['The last reply has no draft.'])
  })

  test('says so when there is nothing to copy', async ($, on) => {
    const seen = clipboard(on, [
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
    ])
    await runCommand($, 'copy code')
    expect(seen.copies).toEqual([])
    expect(seen.toasts).toEqual(['The last reply has no code block.'])
  })

  test('says how to use it when the arguments are wrong', async ($, on) => {
    const seen = clipboard(on, [...messages])
    await runCommand($, 'paste')
    expect(seen.toasts).toEqual(['Usage: /reply-style copy [code|draft]'])
  })
})
