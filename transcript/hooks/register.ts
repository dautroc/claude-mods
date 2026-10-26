import type { EngineInterface, Register } from 'claude-code'

import { toMarkdown } from './markdown'

type Engine = EngineInterface

// Writes this chat as Markdown to a file of the session's, then has Mado open
// it in the editor in its enlarged float. Answers what the person should be
// told, or nothing once the float is on its way.
async function open($: Engine): Promise<string | undefined> {
  const rows = await $.session.messages()
  if (rows.length === 0) {
    return 'Nothing in this chat yet.'
  }

  const id = (await $.session.id()).slice(0, 8)
  const root = await $.session.root()
  const project = root.split('/').filter(part => part !== '').at(-1) ?? root
  const { markdown, line } = toMarkdown(rows, `Chat ${id} · ${project}`)

  // One file per session, rewritten on each run.
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  const path = `${tmp}/claude-transcripts/transcript-${id}.md`
  await $.fs.write(path, markdown)

  // Set in every Mado pane, and still the session's after a rename.
  const session = await $.env.get('MADO_SESSION')
  if (session === undefined || session === '') {
    return `Claude isn't running in a Mado pane, so nothing opened. The chat is in ${path}`
  }

  // edit-file runs the session's editor, nvim unless set otherwise, as
  // `nvim +LINE PATH`.
  const ran = await $.process
    .run(['mado', 'action', '-s', session, 'edit-file', path, String(line)])
    .catch((error: unknown) => ({ exitCode: -1, stderr: String(error) }))
  if (ran.exitCode !== 0) {
    const why = ran.stderr.trim() || `mado exited with ${ran.exitCode}`

    return `Couldn't open it in Mado: ${why}. The chat is in ${path}`
  }

  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'transcript',
      description: 'Open this chat as Markdown in nvim, in a Mado float, to read and search it',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'transcript' }, async $ => {
    const said = await open($)

    return said === undefined ? {} : { text: said }
  })
}
