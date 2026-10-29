import type { EngineInterface, Register } from 'claude-code'

import { keptArgs, optionsOf, relaunchScript, shellOf, typedLine } from './relaunch'

type Engine = EngineInterface

// Everything a restart needs, read before /exit: which process to wait for,
// the shell to type into, and what to type.
type Plan = {
  claude: string
  shell: string
  id: string
  isResumed: boolean
  file: string
  script: string
  line: string
  log: string
  mado: { session: string; pane: string } | undefined
}

function failed(error: unknown): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: -1, stdout: '', stderr: String(error) }
}

// Where this session runs in Mado, or undefined outside it (or when Mado
// can't say): the helper then types on the terminal itself.
async function madoPane($: Engine, claude: string): Promise<Plan['mado']> {
  const session = await $.env.get('MADO_SESSION')
  if (session === undefined || session === '') {
    return undefined
  }

  const located = await $.process.run(['mado', 'locate', '--pid', claude, '--json']).catch(failed)
  const found = /"pane":\s*(\d+)/.exec(located.stdout)?.[1]
  const named = /"session":\s*"([^"]+)"/.exec(located.stdout)?.[1]

  return located.exitCode === 0 && found !== undefined ? { session: named ?? session, pane: found } : undefined
}

// The restart this mod can make, or why it can't: then the built-in /restart
// runs instead, which restarts in place with the old environment.
async function plan($: Engine): Promise<Plan | string> {
  // A child of the hooks runs under Claude Code itself, the shell above it.
  const ids = await $.process.run(['/bin/sh', '-c', 'echo "$PPID $(ps -o ppid= -p "$PPID")"']).catch(failed)
  const [claude, shell] = ids.stdout.trim().split(/\s+/)
  if (claude === undefined || shell === undefined || shell === '') {
    return "couldn't find the process Claude Code runs in"
  }

  const read = await $.process.run(['/usr/bin/python3', '-I', `${$.plugin.root}/bin/argv.py`, claude, shell]).catch(failed)
  if (read.exitCode !== 0) {
    return `couldn't read Claude Code's command line: ${read.stderr.trim() || `python3 exited with ${read.exitCode}`}`
  }
  const [claudeArgv = [], shellArgv = []] = JSON.parse(read.stdout) as string[][]
  const shellPath = shellOf(shellArgv)
  if (shellPath === undefined) {
    return `Claude Code wasn't started from a shell this mod can type into (its parent is ${shellArgv[0] ?? 'unknown'})`
  }
  if (claudeArgv.includes('--no-session-persistence')) {
    return 'this session is not saved to disk, so there is nothing to resume'
  }

  const help = await $.process.run(['claude', '--help']).catch(failed)
  if (help.exitCode !== 0) {
    return `\`claude --help\` failed: ${help.stderr.trim() || `exit ${help.exitCode}`}`
  }

  const id = await $.session.id()
  // A session saves its transcript with its first prompt: before one there
  // is nothing to resume, so the new Claude Code starts a session of its own.
  const isResumed = (await $.session.turns()) > 0
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  const file = `${tmp}/claude-restart/${id}.sh`
  const script = relaunchScript({
    file,
    cwd: await $.session.cwd(),
    id: isResumed ? id : undefined,
    args: keptArgs(claudeArgv.slice(1), optionsOf(help.stdout)),
    shell: shellPath,
  })

  return {
    claude,
    shell,
    id,
    isResumed,
    file,
    script,
    line: typedLine(shellPath, file),
    log: `${tmp}/claude-restart/${id}.log`,
    mado: await madoPane($, claude),
  }
}

// Writes the script and leaves the helper running, detached from the hooks,
// so it outlives this process; answers the helper's pid.
async function startHelper($: Engine, restart: Plan): Promise<string> {
  await $.fs.write(restart.file, restart.script)
  const started = await $.process.run(
    [
      '/bin/sh',
      '-c',
      'nohup /bin/sh "$0" "$@" >"$LOG" 2>&1 </dev/null & echo $!',
      `${$.plugin.root}/bin/relaunch.sh`,
      restart.claude,
      restart.shell,
      restart.id,
      restart.line,
      restart.mado?.session ?? '',
      restart.mado?.pane ?? '',
    ],
    { env: { LOG: restart.log } },
  )
  if (started.exitCode !== 0) {
    throw new Error(started.stderr.trim() || `sh exited with ${started.exitCode}`)
  }

  return started.stdout.trim()
}

export const register: Register = on => {
  // `/restart` is the built-in's name, which a mod can't register; its
  // `command.run` is ours to answer. Its alias `/update` arrives here too.
  on('command.run', { command: 'restart' }, async ($, e, next) => {
    const restart = await plan($).catch((error: unknown) => `couldn't read what to restart (${String(error)})`)
    if (typeof restart === 'string') {
      $.ui.log(`restart: ${restart}, so the built-in /restart runs instead.`)

      return next(e)
    }

    const helper = await startHelper($, restart).catch((error: unknown) => {
      $.ui.log(`restart: couldn't start the helper (${String(error)}), so the built-in /restart runs instead.`)
    })
    if (helper === undefined) {
      return next(e)
    }

    // The command's answer is drawn first; /exit waits for the session to be
    // idle anyway.
    $.clock.after(300, () => {
      $.command.run({ command: 'exit' }).catch(async (error: unknown) => {
        await $.process.run(['kill', helper]).catch(failed)
        $.ui.toast(`Couldn't restart: ${String(error)}`)
      })
    })

    return {
      text: restart.isResumed
        ? 'Restarting Claude Code; this session comes back in a moment.'
        : 'Restarting Claude Code. Nothing was sent in this session yet, so it starts as a new one.',
    }
  }).catch(($, e, next) => next(e))
}
