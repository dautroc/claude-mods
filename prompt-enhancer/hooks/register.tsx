import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelForkResult, Register } from 'claude-code'

import type { Phase } from '../types'
import { buildAsk, extractPrompt, instructionPaths, projectContext } from './enhance'
import type { InstructionFile } from './enhance'

type Engine = EngineInterface
type Outcome = { ok: true; text: string } | { ok: false; why: string }

const IDLE: Phase = { kind: 'idle' }
// Change the tag when Phase's fields change: it declines what an earlier
// version stored, which outlives a reload.
const phase = atom({ plugin: 'prompt-enhancer', key: 'phase' } as const, IDLE, {
  shape: 'phase-1',
})
const hasDraft = atom({ plugin: 'prompt-enhancer', key: 'hasDraft' } as const, false)

// A draft worth enhancing: some words, not a slash command or a shell line.
function isEnhanceable(text: string): boolean {
  const trimmed = text.trim()

  return trimmed !== '' && !trimmed.startsWith('/') && !trimmed.startsWith('!')
}

// The last hasDraft written, so a keystroke costs a state write only when
// the band has to change.
let known: boolean | undefined

async function track($: Engine, text: string) {
  const enhanceable = isEnhanceable(text)
  if (enhanceable !== known) {
    known = enhanceable
    await update($, hasDraft, () => enhanceable)
  }

  // The box was sent or cleared: the enhanced prompt in it is gone.
  if (text.trim() === '' && (await read($, phase)).kind === 'enhanced') {
    await update($, phase, () => IDLE)
  }
}

async function rewrite($: Engine, draft: string): Promise<Outcome> {
  const ask = buildAsk(draft)
  // The fork reads the session as the model last saw it: the system prompt,
  // the project's instructions, the skills listed and the whole chat.
  let reply: ModelForkResult = await $.model.fork({ prompt: ask })
  if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
    reply = await completeFresh($, ask)
  }

  if (!reply.isAnswered) {
    return { ok: false, why: whyUnanswered(reply) }
  }

  const text = extractPrompt(reply.text)

  return text === '' ? { ok: false, why: 'the model sent back an empty prompt' } : { ok: true, text }
}

function whyUnanswered(reply: Exclude<ModelForkResult, { isAnswered: true }>): string {
  switch (reply.reason) {
    case 'api-error':
      return `the API answered ${reply.status ?? 'nothing'} (${reply.error})`
    case 'empty-reply':
      return 'the model answered with no text'
    case 'aborted':
      return 'it was interrupted'
    case 'nothing-to-fork':
      return 'there was no conversation to read'
  }
}

// Before the session's first turn there is nothing to fork: send the
// project's instructions and the skills list along with the draft instead.
async function completeFresh($: Engine, ask: string) {
  const root = await $.session.root()
  const files: InstructionFile[] = []
  for (const path of instructionPaths((await $.env.get('HOME')) ?? '', root)) {
    try {
      files.push({ path, text: await $.fs.read(path) })
    } catch {
      // Not there: Claude Code skips it too.
    }
  }

  const commands = (await $.command.list()).filter(command => command.source !== 'builtin')
  const request = { prompt: ask, system: projectContext(root, files, commands), maxTokens: 2048, timeoutMs: 120_000 }

  try {
    return await $.model.complete({ ...request, model: await $.session.model() })
  } catch {
    return await $.model.complete({ ...request, model: 'sonnet' })
  }
}

// Returns what to tell the person when the box was left as it was.
async function enhance($: Engine, draft: string, isCommand: boolean): Promise<string | undefined> {
  if (!isEnhanceable(draft)) {
    return 'Type a prompt first, then enhance it.'
  }

  const id = crypto.randomUUID()
  await update($, phase, (): Phase => ({ kind: 'enhancing', id, original: draft }))
  const outcome = await rewrite($, draft)

  const now = await read($, phase)
  if (now.kind !== 'enhancing' || now.id !== id) {
    return undefined
  }

  if (!outcome.ok) {
    await update($, phase, () => IDLE)

    return `Couldn't enhance the prompt: ${outcome.why}.`
  }

  // /enhance took the draft out of the box; a press left it there.
  const box = (await $.prompt.read()).text
  if (isCommand ? box.trim() !== '' : box !== draft) {
    await update($, phase, () => IDLE)

    return 'The prompt box changed while the prompt was being enhanced, so it was left as it is.'
  }

  const filled = await $.prompt.fill({ text: outcome.text, mode: 'replace' })
  if (!filled.isFilled) {
    await update($, phase, () => IDLE)

    return "Couldn't put the enhanced prompt in the box."
  }

  await update($, phase, (): Phase => ({ kind: 'enhanced', original: draft }))

  return undefined
}

async function pressEnhance($: Engine) {
  const problem = await enhance($, (await $.prompt.read()).text, false)
  if (problem !== undefined) {
    $.ui.toast(problem)
  }
}

async function send($: Engine) {
  const { text } = await $.prompt.read()
  if (text.trim() === '') {
    $.ui.toast('The prompt box is empty.')

    return
  }

  await $.prompt.fill({ text: '', mode: 'replace' })
  await update($, phase, () => IDLE)
  // Resolves only once the turn starts, which waits for a running one.
  $.prompt.submit({ text, asUser: true }).catch(() => $.ui.toast("Couldn't send the prompt."))
}

async function undo($: Engine) {
  const now = await read($, phase)
  if (now.kind === 'enhanced') {
    await $.prompt.fill({ text: now.original, mode: 'replace' })
  }

  await update($, phase, () => IDLE)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'enhance',
      description: 'Rewrite a vague prompt into a specific one, using this project and the chat so far',
      argumentHint: '<prompt>',
    })

    // A reload ends any enhancement that was running.
    await update($, phase, now => (now.kind === 'enhancing' ? IDLE : now))
    known = isEnhanceable((await $.prompt.read()).text)
    await update($, hasDraft, () => known === true)

    return next(e)
  })

  on('command.run', { command: 'enhance' }, async ($, e) => {
    if (e.args.trim() === '') {
      return { text: 'Type /enhance followed by your prompt, or type the prompt and press ✨ Enhance above the box.' }
    }

    const problem = await enhance($, e.args.trim(), true)

    return { text: problem ?? 'The enhanced prompt is in the box. Edit it if you like, then press Send or Enter.' }
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await track($, box.text)

    return box
  })

  on('prompt.change', async ($, e, next) => {
    const changed = await next(e)
    await track($, e.text)

    return changed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) {
      return next(e)
    }

    const now = await read($, phase)
    if (now.kind === 'idle' && !(await read($, hasDraft))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    // What the mods beneath draw in the band (paste-thumbnails' pictures)
    // stays, above this row.
    const beneath = await next(e)

    const row =
      now.kind === 'enhancing' ? (
        <Box gap={1}>
          <Text color="magenta">✨ Enhancing your prompt…</Text>
          <Button key="cancel" hotkey="c" label="Cancel" onPress={() => update($, phase, () => IDLE)} />
        </Box>
      ) : now.kind === 'enhanced' ? (
        <Box gap={1}>
          <Button key="send" hotkey="s" variant="primary" label="Send" onPress={() => send($)} />
          <Button key="undo" hotkey="u" label="Undo" onPress={() => undo($)} />
          <Text dimColor>Enhanced. Edit it in the box if you like.</Text>
        </Box>
      ) : (
        <Box gap={1}>
          <Button key="enhance" hotkey="e" label="✨ Enhance" onPress={() => pressEnhance($)} />
          <Text dimColor>Make this prompt specific, using the project and the chat so far</Text>
        </Box>
      )

    return (
      <Box flexDirection="column">
        {beneath}
        {row}
      </Box>
    )
  })
}
