// The command line that starts this session again: the running Claude Code's
// own flags, read against `claude --help`, less those that pick a session or
// send a prompt, run from a fresh login shell.

// How many values an option takes, as commander reads them: `<v>` the next
// word whatever it is, `[v]` the next word unless it is an option, `<v...>`
// every word up to the next option.
export type Arity = 'none' | 'one' | 'optional' | 'many'

// Each spelling of an option (`-c`, `--continue`) to its long name and arity.
export type Options = ReadonlyMap<string, { name: string; arity: Arity }>

// Options that pick the session or what the run does with it: the restart
// names the session itself, and the others would start something else.
const DROPPED = new Set([
  'continue',
  'resume',
  'session-id',
  'fork-session',
  'from-pr',
  'teleport',
  'print',
  'background',
  'cloud',
  'desktop',
  'worktree',
  'tmux',
  'help',
  'version',
])

// Shells whose `-l -i -c` and quoting the restart's lines are written for.
const SHELLS = new Set(['zsh', 'bash', 'sh', 'ksh', 'dash', 'mksh', 'yash'])

// Reads the options `claude --help` lists: a line indented two spaces, its
// spellings, then the value it takes, if any.
export function optionsOf(help: string): Options {
  const options = new Map<string, { name: string; arity: Arity }>()
  for (const line of help.split('\n')) {
    const match = /^ {2}(-{1,2}[\w-]+(?:, -{1,2}[\w-]+)*)(?: ([<[][^\s]*[>\]]))?(?: {2}|$)/.exec(line)
    if (match === null) {
      continue
    }

    const spellings = (match[1] ?? '').split(', ')
    const value = match[2]
    const arity: Arity =
      value === undefined ? 'none' : value.startsWith('[') ? 'optional' : value.endsWith('...>') ? 'many' : 'one'
    const name = (spellings.at(-1) ?? '').replace(/^-+/, '')
    for (const spelling of spellings) {
      options.set(spelling, { name, arity })
    }
  }

  return options
}

function isValue(word: string | undefined): word is string {
  return word !== undefined && !(word.startsWith('-') && word.length > 1)
}

// The flags of `args` (argv without its first word) to start the session
// again with: every option kept with its values, as written, but the DROPPED
// ones; a word no option takes is the prompt it was started with, and goes.
// An option `claude --help` doesn't list keeps the word after it, if that
// isn't an option, in case it is the option's value.
export function keptArgs(args: readonly string[], options: Options): string[] {
  const kept: string[] = []
  for (let at = 0; at < args.length; at++) {
    const word = args[at] ?? ''
    if (word === '--') {
      break
    }
    if (!word.startsWith('-') || word === '-') {
      continue
    }

    const equals = word.indexOf('=')
    const option = options.get(equals > 0 ? word.slice(0, equals) : word)
    const values: string[] = []
    if (equals < 0) {
      const arity = option?.arity ?? 'optional'
      if (arity === 'one' && at + 1 < args.length) {
        values.push(args[++at] ?? '')
      } else if (arity === 'optional' && isValue(args[at + 1])) {
        values.push(args[++at] ?? '')
      } else if (arity === 'many') {
        while (isValue(args[at + 1])) {
          values.push(args[++at] ?? '')
        }
      }
    }
    if (option === undefined || !DROPPED.has(option.name)) {
      kept.push(word, ...values)
    }
  }

  return kept
}

// The shell to start again, from its argument vector: a login shell's `-zsh`
// read as `zsh`; undefined for a program that isn't a shell listed in SHELLS.
export function shellOf(argv: readonly string[]): string | undefined {
  const first = (argv[0] ?? '').replace(/^-/, '')

  return SHELLS.has(first.split('/').at(-1) ?? '') ? first : undefined
}

// A word as the shell reads it back: as it is when it holds nothing the
// shell would read otherwise, else in single quotes.
export function word(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`
}

// The script the new shell runs: it removes itself, starts Claude Code in the
// session's directory (resuming `id`, or new when there is nothing to resume),
// and once that exits becomes the login shell the pane had.
export function relaunchScript(input: {
  file: string
  cwd: string
  id: string | undefined
  args: readonly string[]
  shell: string
}): string {
  const resume = input.id === undefined ? [] : ['--resume', input.id]
  const claude = ['command', 'claude', ...resume, ...input.args].map(word).join(' ')

  return [`rm -f -- ${word(input.file)}`, `cd -- ${word(input.cwd)} && ${claude}`, `exec ${word(input.shell)} -l`, ''].join(
    '\n',
  )
}

// What is typed into the old shell once Claude Code has exited: it is
// replaced by a login shell that reads its startup files again, so the
// environment they set is the new one, and runs the script. The leading
// space keeps the line out of a history that ignores such lines.
export function typedLine(shell: string, file: string): string {
  return ` exec ${word(shell)} -l -i -c ${word(`. ${word(file)}`)}`
}
