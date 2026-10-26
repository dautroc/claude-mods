import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult, SessionMessage, ToolUseSummary } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { MAX_ROWS, toMarkdown } from '../hooks/markdown'

const ID = '1cfbb168-0ea5-4cdb-9645-4cf869f22c52'
const TMP = '/var/folders/xy/T/'
const FILE = '/var/folders/xy/T/claude-transcripts/transcript-1cfbb168.md'

function you(text: string): SessionMessage {
  return { role: 'user', text, toolUses: [] }
}

function claude(text: string, ...toolUses: ToolUseSummary[]): SessionMessage {
  return { role: 'assistant', text, toolUses }
}

function use(tool: string, input: Record<string, unknown>, isError = false): ToolUseSummary {
  return { tool_use_id: `toolu-${tool}`, tool, input, text: 'output', ...(isError ? { isError: true } : {}) }
}

// The user row that carries tool results back.
function results(): SessionMessage {
  return { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu-Bash', text: 'output', isError: false }] }
}

function ran(exitCode = 0, stderr = ''): ProcessRunResult {
  return { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

// Stands for the engine: a session holding `rows`, in Mado unless `env` says
// otherwise, and a record of what was written and run.
function engine(on: On, rows: SessionMessage[], env: Record<string, string> = { TMPDIR: TMP, MADO_SESSION: 'claude-mods' }, mado = ran()) {
  const seen = { writes: [] as { path: string; text: string }[], runs: [] as (readonly string[])[] }
  mock.env(on, env)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: rows }))
  on('session.id', () => ({ value: ID }))
  on('session.root', () => ({ value: '/Users/me/tools/claude-mods' }))
  on('fs.write', (_, e) => {
    seen.writes.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    seen.runs.push(e.argv)

    return { value: mado }
  })

  return seen
}

async function transcript($: Engine) {
  await $.session.start({ cwd: '/Users/me/tools/claude-mods', surface: 'terminal', isInteractive: true })

  return $.command.run({
    command: 'transcript',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

describe('the Markdown', () => {
  test('has a heading per prompt and per reply, tool calls as one line each with no output', () => {
    const { markdown } = toMarkdown(
      [
        you('Why does the test fail?'),
        claude(''),
        claude('', use('Bash', { command: 'make test', description: 'Run the tests' })),
        results(),
        claude('', use('Read', { file_path: '/repo/src/a.ts' }), use('Grep', { pattern: 'fixture', path: '/repo' })),
        results(),
        claude('The fixture path was **absolute**.'),
      ],
      'Chat 1cfbb168 · claude-mods',
    )

    expect(markdown).toBe(
      [
        '# Chat 1cfbb168 · claude-mods',
        '',
        '## You',
        '',
        'Why does the test fail?',
        '',
        '## Claude',
        '',
        '- Bash: `make test`',
        '- Read: `/repo/src/a.ts`',
        '- Grep: `fixture`',
        '',
        'The fixture path was **absolute**.',
        '',
      ].join('\n'),
    )
  })

  test('opens on the newest prompt', () => {
    const { markdown, line } = toMarkdown([you('one'), claude('a'), you('two'), claude('b')], 'Chat')

    expect(markdown.split('\n')[line - 1]).toBe('## You')
    expect(markdown.split('\n')[line + 1]).toBe('two')
  })

  test('writes a command as typed, and leaves out what the engine wrote and this command', () => {
    const { markdown } = toMarkdown(
      [
        you('<local-command-caveat>Caveat: the command below was run by the user.</local-command-caveat>'),
        you('<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>'),
        you('<local-command-stdout>Set model to opus</local-command-stdout>'),
        you('<command-name>/transcript</command-name>\n            <command-message>transcript</command-message>\n            <command-args></command-args>'),
        you('<bash-input>git status</bash-input>'),
        you('<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>'),
        you('<system-reminder>The date changed.</system-reminder>\nAdd a test.'),
        claude('', use('Skill', { skill: 'plugin-authoring' })),
        you('Base directory for this skill: /skills/plugin-authoring\n\nWrite each mod in its own folder.'),
        claude('Done.'),
      ],
      'Chat',
    )

    const prompts = markdown.split('## You\n\n').slice(1).map(part => part.split('\n')[0])
    expect(prompts).toEqual(['/model opus', '! git status', 'Add a test.'])
    expect(markdown).toContain('- Skill: `plugin-authoring`')
    expect(markdown).not.toMatch(/Caveat|Set model|transcript\b|clean|reminder|Base directory/)
  })

  test('marks a failed call and an interruption, and cuts a long input to one line', () => {
    const long = `echo ${'x'.repeat(200)}\necho done`
    const { markdown } = toMarkdown(
      [you('go'), claude('', use('Bash', { command: long }, true)), you('[Request interrupted by user for tool use]')],
      'Chat',
    )

    const line = markdown.split('\n').find(l => l.startsWith('- Bash'))
    expect(line).toMatch(/^- Bash: `echo x+…` \(failed\)$/)
    expect(line?.length).toBeLessThan(140)
    expect(markdown).toContain('\n_Interrupted._\n')
    expect(markdown.match(/## You/g)).toHaveLength(1)
  })

  test('puts backticks in an input inside a longer fence', () => {
    const { markdown } = toMarkdown([you('go'), claude('', use('Bash', { command: 'echo `date`' }))], 'Chat')

    expect(markdown).toContain('- Bash: `` echo `date` ``')
  })

  test('heads a compaction summary as one, and says when the oldest rows were cut', () => {
    const summary = 'This session is being continued from a previous conversation that ran out of context.'
    const cut = toMarkdown([you(summary), claude('ok'), ...Array.from({ length: MAX_ROWS - 2 }, () => claude(''))], 'Chat')
    const whole = toMarkdown([you(summary), claude('ok')], 'Chat')

    expect(whole.markdown).toContain(`## Summary of earlier turns\n\n${summary}`)
    expect(whole.markdown).not.toContain('left out')
    expect(cut.markdown).toContain('> Earlier messages are left out')
  })
})

describe('/transcript', () => {
  test('writes the chat to a file and opens it in Mado on the newest prompt', async ($, on) => {
    const seen = engine(on, [you('one'), claude('a'), you('two'), claude('b')])

    const result = await transcript($)

    expect(result.text).toBeUndefined()
    expect(seen.writes.map(w => w.path)).toEqual([FILE])
    expect(seen.writes[0]?.text).toMatch(/^# Chat 1cfbb168 · claude-mods\n/)
    const line = toMarkdown([you('one'), claude('a'), you('two'), claude('b')], 'Chat').line
    expect(seen.runs).toEqual([['mado', 'action', '-s', 'claude-mods', 'edit-file', FILE, String(line)]])
  })

  test('outside Mado, writes the file and says where it is', async ($, on) => {
    const seen = engine(on, [you('one'), claude('a')], { TMPDIR: TMP })

    const result = await transcript($)

    expect(seen.runs).toEqual([])
    expect(result.text).toBe(`Claude isn't running in a Mado pane, so nothing opened. The chat is in ${FILE}`)
  })

  test('says why when Mado refuses', async ($, on) => {
    engine(on, [you('one'), claude('a')], { TMPDIR: TMP, MADO_SESSION: 'gone' }, ran(1, 'no session gone\n'))

    const result = await transcript($)

    expect(result.text).toBe(`Couldn't open it in Mado: no session gone. The chat is in ${FILE}`)
  })

  test('before the first prompt, says so and writes nothing', async ($, on) => {
    const seen = engine(on, [])

    const result = await transcript($)

    expect(result.text).toBe('Nothing in this chat yet.')
    expect(seen.writes).toEqual([])
  })
})
