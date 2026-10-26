import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelForkResult, Register } from 'claude-code'

import type { Entry } from '../types'
import { fitTables } from './tables'
import { FRESH_SYSTEM, buildAsk, isPending } from './thread'

type Engine = EngineInterface
type Reply = { answer: string } | { error: string }

const PANE = 'aside'
// Change the tag when Entry's fields change: it declines what an earlier
// version stored, which outlives a reload.
const thread = atom({ plugin: 'aside', key: 'thread' } as const, [], { shape: 'thread-1' })
const draft = atom({ plugin: 'aside', key: 'draft' } as const, '')

// The question typed after /aside, held here so that the command's record in
// the main conversation carries no arguments.
let typed = ''

async function reply($: Engine, earlier: readonly Entry[], question: string): Promise<Reply> {
  const prompt = buildAsk(earlier, question)
  // The fork reads the main conversation as the model last saw it; nothing it
  // says is added to that conversation.
  let result: ModelForkResult = await $.model.fork({ prompt })
  if (!result.isAnswered && result.reason === 'nothing-to-fork') {
    result = await completeFresh($, prompt)
  }

  if (!result.isAnswered) {
    return { error: `No answer: ${whyUnanswered(result)}.` }
  }

  const answer = result.text.trim()

  return answer === '' ? { error: 'No answer: the model sent back no text.' } : { answer }
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
  const got = await reply($, earlier, text)
  // A New thread pressed meanwhile took the question away: the map finds none.
  await update($, thread, list => list.map(entry => (entry.id === id ? { ...entry, ...got } : entry)))
  await toEnd($)
}

// Asks on a timer, so the command or the field that asked is done at once and
// the answer lands in the pane whenever it comes.
function askLater($: Engine, question: string) {
  $.clock.after(1, () => void ask($, question))
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

    // A reload drops an answer that was on its way.
    await update($, thread, list =>
      list.map(entry => (isPending(entry) ? { ...entry, error: 'No answer: Claude Code reloaded the mod.' } : entry)),
    )

    return next(e)
  })

  // Registered first, so it runs first: the rows the main conversation keeps
  // for this command then hold `/aside` and no question.
  on('command.run', { command: 'aside' }, ($, e, next) => {
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
        {list.length > 0 && <Button key="new" label="New thread" onPress={() => reset($)} />}
      </Box>
    )
  })
}
