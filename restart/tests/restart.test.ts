import { describe, expect, mock, test } from 'claude-code/testing'
import type { CommandRunResult, On, ProcessRunResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { keptArgs, optionsOf, relaunchScript, shellOf, typedLine, word } from '../hooks/relaunch'

const ID = '4613ac3d-4826-4fb4-b1ca-a8dae4406d42'
const TMP = '/var/folders/xy/T/'
const FILE = `/var/folders/xy/T/claude-restart/${ID}.sh`
const CWD = '/Users/me/tools/claude-mods'

// The options part of `claude --help`, as 2.1.312 prints it, wrapped lines
// included.
const HELP = `Usage: claude [options] [command] [prompt]

Options:
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
      Edit")
  --bg, --background                    Start the session in the background and
                                        --resume <session-id>, continues that
  -c, --continue                        Continue the most recent conversation in
  --chrome                              Enable Claude in Chrome integration
  -d, --debug [filter]                  Enable debug mode with optional category
  --fork-session                        When resuming, create a new session ID
  --model <model>                       Model for the current session.
  -n, --name <name>                     Set a display name for this session
  --permission-mode <mode>              Permission mode to use for the session
  --plugin-dir <path>                   Load plugins from a directory
  -p, --print                           Print response and exit
  -r, --resume [value]                  Resume a conversation by session ID
  --session-id <uuid>                   Use a specific session ID
  --settings <file-or-json>             Path to a settings JSON file
  -w, --worktree [name]                 Create a new git worktree for this

Commands:
  mcp                                   Configure and manage MCP servers
`

function ran(stdout = '', exitCode = 0, stderr = ''): ProcessRunResult {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

type World = {
  claude?: readonly string[]
  shell?: readonly string[]
  turns?: number
  env?: Record<string, string>
  located?: ProcessRunResult
}

// Stands for the engine and the machine: Claude Code (pid 200) started by
// `world.claude` from the shell `world.shell` (pid 100), in a Mado pane
// unless `world.env` says otherwise; the built-in /restart answers beneath.
function engine(on: On, world: World = {}) {
  const seen = {
    runs: [] as (readonly string[])[],
    envs: [] as (Record<string, string> | undefined)[],
    writes: [] as { path: string; text: string }[],
    commands: [] as string[],
    logs: [] as string[],
  }
  const clock = mock.clock(on)
  mock.env(on, world.env ?? { TMPDIR: TMP, MADO_SESSION: 'claude-mods' })
  on('session.id', () => ({ value: ID }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.turns', () => ({ value: world.turns ?? 3 }))
  on('fs.write', (_, e) => {
    seen.writes.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    seen.logs.push(e.text)

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    seen.runs.push(e.argv)
    seen.envs.push(e.init?.env)
    const [program, first] = e.argv
    if (program === '/bin/sh' && e.argv.some(a => a.endsWith('/bin/relaunch.sh'))) {
      return { value: ran('4242\n') }
    }
    if (program === '/bin/sh') {
      return { value: ran('200 100\n') }
    }
    if (program === '/usr/bin/python3') {
      return { value: ran(JSON.stringify([world.claude ?? ['claude'], world.shell ?? ['/bin/zsh', '-l']])) }
    }
    if (program === 'claude' && first === '--help') {
      return { value: ran(HELP) }
    }
    if (program === 'mado') {
      return { value: world.located ?? ran('{"pane":121,"session":"claude-mods"}\n') }
    }

    return { value: ran() }
  })
  on('command.run', (_, e) => {
    seen.commands.push(e.command)

    return e.command === 'restart' ? { text: 'built-in restart' } : {}
  })

  return { seen, clock }
}

function restart($: Engine): Promise<CommandRunResult> {
  return $.command.run({
    command: 'restart',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

describe('the command line', () => {
  const options = optionsOf(HELP)

  test('reads each spelling of an option and the values it takes', () => {
    expect(options.get('-c')).toEqual({ name: 'continue', arity: 'none' })
    expect(options.get('--allowedTools')).toEqual({ name: 'allowed-tools', arity: 'many' })
    expect(options.get('-r')).toEqual({ name: 'resume', arity: 'optional' })
    expect(options.get('--model')).toEqual({ name: 'model', arity: 'one' })
    expect(options.has('--resume <session-id>, continues that')).toBe(false)
    expect(options.has('mcp')).toBe(false)
  })

  test('keeps the flags and drops what picks a session or sends a prompt', () => {
    const argv = [
      '--model',
      'opus',
      '-r',
      ID,
      '--settings',
      '{"remoteControlAtStartup": false}',
      '--fork-session',
      '-c',
      '--add-dir',
      '/a',
      '/b',
      '--name=work',
      '-w',
      'fix the tests',
    ]

    expect(keptArgs(argv, options)).toEqual([
      '--model',
      'opus',
      '--settings',
      '{"remoteControlAtStartup": false}',
      '--add-dir',
      '/a',
      '/b',
      '--name=work',
    ])
  })

  test('drops a prompt after the options, and what follows --', () => {
    expect(keptArgs(['--chrome', 'why does it fail?'], options)).toEqual(['--chrome'])
    expect(keptArgs(['--model', 'haiku', '--', '-p is a prompt'], options)).toEqual(['--model', 'haiku'])
    expect(keptArgs(['-r'], options)).toEqual([])
    expect(keptArgs(['--session-id', ID, '--chrome'], options)).toEqual(['--chrome'])
  })

  test('keeps the word after an option it does not know', () => {
    expect(keptArgs(['--secret-flag', 'value', '--chrome'], options)).toEqual(['--secret-flag', 'value', '--chrome'])
  })

  test('takes a POSIX shell, a login one by its name, and nothing else', () => {
    expect(shellOf(['/bin/zsh', '-l'])).toBe('/bin/zsh')
    expect(shellOf(['-zsh'])).toBe('zsh')
    expect(shellOf(['/opt/homebrew/bin/bash'])).toBe('/opt/homebrew/bin/bash')
    expect(shellOf(['fish'])).toBeUndefined()
    expect(shellOf(['/Applications/Mado.app/Contents/Helpers/mado', 'server'])).toBeUndefined()
  })

  test('quotes only the words that need it', () => {
    expect(word('--model')).toBe('--model')
    expect(word('/Users/me/tools')).toBe('/Users/me/tools')
    expect(word('{"a": 1}')).toBe(`'{"a": 1}'`)
    expect(word("it's")).toBe(`'it'\\''s'`)
  })

  test('writes a script that resumes in the directory, then becomes the login shell', () => {
    const script = relaunchScript({ file: FILE, cwd: '/Users/me/my repo', id: ID, args: ['--settings', '{"a": 1}'], shell: '/bin/zsh' })

    expect(script.split('\n')).toEqual([
      `rm -f -- ${FILE}`,
      `cd -- '/Users/me/my repo' && command claude --resume ${ID} --settings '{"a": 1}'`,
      'exec /bin/zsh -l',
      '',
    ])
    expect(relaunchScript({ file: FILE, cwd: CWD, id: undefined, args: [], shell: 'zsh' })).toContain(`cd -- ${CWD} && command claude\n`)
  })

  test('types a line that starts a login shell to run it', () => {
    expect(typedLine('/bin/zsh', FILE)).toBe(` exec /bin/zsh -l -i -c '. ${FILE}'`)
  })
})

describe('/restart', () => {
  test('leaves the helper waiting on Claude Code, then exits', async ($, on) => {
    const { seen, clock } = engine(on, {
      claude: ['claude', '--model', 'haiku', '-c', '--plugin-dir', '/mods/x'],
    })

    const answer = await restart($)

    expect(answer.text).toBe('Restarting Claude Code; this session comes back in a moment.')
    expect(seen.writes).toEqual([
      {
        path: FILE,
        text: [`rm -f -- ${FILE}`, `cd -- ${CWD} && command claude --resume ${ID} --model haiku --plugin-dir /mods/x`, 'exec /bin/zsh -l', ''].join('\n'),
      },
    ])

    const helper = seen.runs.findIndex(argv => argv.some(a => a.endsWith('/bin/relaunch.sh')))
    const argv = seen.runs[helper] ?? []
    expect(argv.slice(4)).toEqual(['200', '100', ID, ` exec /bin/zsh -l -i -c '. ${FILE}'`, 'claude-mods', '121'])
    expect(argv[2]).toContain('nohup')
    expect(seen.envs[helper]).toEqual({ LOG: `/var/folders/xy/T/claude-restart/${ID}.log` })
    expect(seen.runs).toContainEqual(['mado', 'locate', '--pid', '200', '--json'])
    // Answered here: the built-in beneath never runs.
    expect(seen.commands).toEqual([])

    await clock.advance(300)

    expect(seen.commands).toEqual(['exit'])
  })

  test('outside Mado, hands the helper no pane', async ($, on) => {
    const { seen } = engine(on, { env: { TMPDIR: TMP } })

    await restart($)

    const argv = seen.runs.find(a => a.some(w => w.endsWith('/bin/relaunch.sh'))) ?? []
    expect(argv.slice(-2)).toEqual(['', ''])
    expect(seen.runs.some(a => a[0] === 'mado')).toBe(false)
  })

  test('when Mado cannot place the process, hands the helper no pane', async ($, on) => {
    const { seen } = engine(on, { located: ran('', 1, 'no pane runs that process') })

    await restart($)

    const argv = seen.runs.find(a => a.some(w => w.endsWith('/bin/relaunch.sh'))) ?? []
    expect(argv.slice(-2)).toEqual(['', ''])
  })

  test('before the first prompt, starts a new session with the same flags', async ($, on) => {
    const { seen } = engine(on, { turns: 0, claude: ['claude', '--chrome'] })

    const answer = await restart($)

    expect(answer.text).toMatch(/starts as a new one/)
    expect(seen.writes[0]?.text).toContain(`cd -- ${CWD} && command claude --chrome\n`)
  })

  test('hands over to the built-in when Claude Code was not started from a shell', async ($, on) => {
    const { seen, clock } = engine(on, { shell: ['/Applications/Mado.app/Contents/Helpers/mado', 'server'] })

    const answer = await restart($)
    await clock.advance(300)

    expect(answer.text).toBe('built-in restart')
    expect(seen.logs[0]).toMatch(/wasn't started from a shell .*built-in \/restart runs instead/)
    expect(seen.writes).toEqual([])
    expect(seen.commands).toEqual(['restart'])
  })

  test('hands over to the built-in when the session is not saved', async ($, on) => {
    const { seen } = engine(on, { claude: ['claude', '--no-session-persistence'] })

    const answer = await restart($)

    expect(answer.text).toBe('built-in restart')
    expect(seen.logs[0]).toMatch(/not saved to disk/)
  })
})
