import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelForkResult, Register } from 'claude-code'

import { fitTables } from './tables'
import { FRESH_SYSTEM, buildAsk, buildHandoff, isAnswered, isPending } from './thread'

type Engine = EngineInterface
type Reply = { answer: string } | { why: string }

const PANE = 'aside'
// Change the tag when Entry's fields change: it declines what an earlier
// version stored, which outlives a reload.
const thread = atom({ plugin: 'aside', key: 'thread' } as const, [], { shape: 'thread-1' })
const draft = atom({ plugin: 'aside', key: 'draft' } as const, '')
// True while a hand-off is being written.
const handing = atom({ plugin: 'aside', key: 'handing' } as const, false)

// What was typed after /aside or /aside-handoff, held here so that the
// command's record in the main conversation carries no arguments.
let typed = ''

async function reply($: Engine, prompt: string): Promise<Reply> {
  // The fork reads the main conversation as the model last saw it; nothing it
  // says is added to that conversation.
  let result: ModelForkResult = await $.model.fork({ prompt })
  if (!result.isAnswered && result.reason === 'nothing-to-fork') {
    result = await completeFresh($, prompt)
  }

  if (!result.isAnswered) {
    return { why: whyUnanswered(result) }
  }

  const answer = result.text.trim()

  return answer === '' ? { why: 'the model sent back no text' } : { answer }
}

async function completeFresh($: Engine, prompt: string) {
  const request = { prompt, system: FRESH_SYSTEM, maxTokens: 4096, timeoutMs: 120_000 }

  try {
    return await $.model.complete({ ...request, model: await $.session.model() })
  } catch {
    return await $.model.complete({ ...request, model: 'sonnet' })
  }
}

function whyUnanswered(result: Exclude<ModelForkResult, { isAnswered: true }>): string {
  switch (result.reason) {
    case 'api-error':
      return `the API answered ${result.status ?? 'nothing'} (${result.error})`
    case 'empty-reply':
      return 'the model answered with no text'
    case 'aborted':
      return 'it was interrupted'
    case 'nothing-to-fork':
      return 'there was no conversation to read'
  }
}

async function ask($: Engine, question: string) {
  const text = question.trim()
  if (text === '') {
    return
  }

  const earlier = await read($, thread)
  if (earlier.some(isPending)) {
    $.ui.toast('Aside is still answering the last question.')

    return
  }

  const id = crypto.randomUUID()
  await update($, thread, list => [...list, { id, question: text }])
  await toEnd($)
  const got = await reply($, buildAsk(earlier, text))
  const done = 'answer' in got ? got : { error: `No answer: ${got.why}.` }
  // A New thread pressed meanwhile took the question away: the map finds none.
  await update($, thread, list => list.map(entry => (entry.id === id ? { ...entry, ...done } : entry)))
  await toEnd($)
}

// Asks on a timer, so the command or the field that asked is done at once and
// the answer lands in the pane whenever it comes.
function askLater($: Engine, question: string) {
  $.clock.after(1, () => void ask($, question))
}

// Writes a request for the main conversation from the answered side
// questions, and adds it to the prompt box for the person to edit and send.
async function handOff($: Engine, wanted: string) {
  const answered = (await read($, thread)).filter(isAnswered)
  if (answered.length === 0) {
    $.ui.toast('Nothing to hand off yet: no side question has an answer.')

    return
  }
  if (await read($, handing)) {
    $.ui.toast('Aside is still writing the hand-off.')

    return
  }

  await update($, handing, () => true)
  const got = await reply($, buildHandoff(answered, wanted.trim()))
  await update($, handing, () => false)
  if (!('answer' in got)) {
    $.ui.toast(`Couldn't write the hand-off: ${got.why}.`)

    return
  }

  // What the person typed meanwhile stays, the request after it.
  const box = (await $.prompt.read()).text
  const filled =
    box.trim() === ''
      ? await $.prompt.fill({ text: got.answer, mode: 'replace' })
      : await $.prompt.fill({ text: `\n\n${got.answer}`, mode: 'append' })
  $.ui.toast(
    filled.isFilled
      ? 'The hand-off is in the prompt box. Edit it, then press Enter.'
      : `Couldn't put the hand-off in the prompt box${filled.refusal === 'dialog' ? ' while a dialog is open' : ''}.`,
  )
}

function handOffLater($: Engine, wanted: string) {
  $.clock.after(1, () => void handOff($, wanted))
}

async function submit($: Engine, value: string) {
  await update($, draft, () => '')
  askLater($, value)
}

async function toEnd($: Engine) {
  await $.ui.scroll({ to: 'end', in: PANE }).catch(() => undefined)
}

async function reset($: Engine) {
  await update($, thread, () => [])
  await update($, draft, () => '')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'aside',
      description: 'Ask a side question about this chat in a pane; follow-ups stay in that thread, out of the main conversation',
      argumentHint: '[question]',
      immediate: true,
    })
    await $.command.register({
      name: 'aside-handoff',
      description: 'Write a request from the Aside thread into the prompt box, to send to the main conversation',
      argumentHint: '[what you want done]',
      immediate: true,
    })

    // A reload drops an answer or a hand-off that was on its way.
    await update($, thread, list =>
      list.map(entry => (isPending(entry) ? { ...entry, error: 'No answer: Claude Code reloaded the mod.' } : entry)),
    )
    await update($, handing, () => false)

    return next(e)
  })

  // Registered first, so it runs first: the rows the main conversation keeps
  // for these commands then hold the command and no arguments.
  on('command.run', { command: ['aside', 'aside-handoff'] }, ($, e, next) => {
    typed = e.args

    return next({ ...e, args: '' })
  }).catch(($, e, next) => (next.called ? next(e) : next({ ...e, args: '' })))

  on('command.run', { command: 'aside' }, async $ => {
    const question = typed
    typed = ''
    await $.ui.open({ id: PANE, title: 'Aside', focus: true })
    askLater($, question)

    return {}
  })

  on('command.run', { command: 'aside-handoff' }, $ => {
    const wanted = typed
    typed = ''
    handOffLater($, wanted)

    return {}
  })

  // A /clear ends the conversation the thread was about.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await reset($)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, thread)
    const typing = await read($, draft)
    const isHanding = await read($, handing)
    const isBusy = list.some(isPending)
    const ui = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = ui
    // The terminal sizes a table to the terminal, not to the pane, which is
    // narrower only while docked beside the transcript.
    const room = e.surface === 'terminal' && e.props.placement === 'dock' ? e.props.bodyColumns : Infinity

    return (
      <Box flexDirection="column" gap={1}>
        {list.length === 0 && (
          <Text dimColor>Ask anything about this chat. The main conversation won't see this thread.</Text>
        )}
        {list.map(entry => (
          <Box flexDirection="column">
            <Text bold color="cyan">
              › {entry.question}
            </Text>
            {entry.answer !== undefined ? (
              <Markdown text={fitTables(entry.answer, room)} />
            ) : entry.error !== undefined ? (
              <Text color="red">{entry.error}</Text>
            ) : (
              <Text dimColor>Thinking…</Text>
            )}
          </Box>
        ))}
        {'Input' in ui && (
          <ui.Input
            key="ask"
            value={typing}
            placeholder={isBusy ? 'Answering…' : list.length === 0 ? 'Ask a side question' : 'Ask a follow-up'}
            submitLabel="ask"
            autoFocus
            onInput={value => update($, draft, () => value)}
            onSubmit={value => submit($, value)}
          />
        )}
        {list.length > 0 && (
          <Box gap={2}>
            {isHanding ? (
              <Text dimColor>Writing the hand-off…</Text>
            ) : (
              list.some(isAnswered) && <Button key="handoff" label="Hand off" onPress={() => handOffLater($, '')} />
            )}
            <Button key="new" label="New thread" onPress={() => reset($)} />
          </Box>
        )}
      </Box>
    )
  })
}
