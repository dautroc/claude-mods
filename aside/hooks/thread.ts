// The text a side question sends the model.

import type { Entry } from '../types'

const RULES = `The user is asking a side question while you work together in this conversation. It is an aside, not part of the main task:

- Answer from what is already in this conversation: the messages, the files and command output you have seen, and the project's instructions.
- Do not call tools, and do not change course on the main work. If the answer needs something the conversation doesn't hold, say what is missing instead of guessing.
- Be brief and direct: a few sentences or a short list. Markdown is fine.
- Reply with the answer only.`

const HANDOFF = `The user has been asking side questions about this conversation in a separate thread, shown below; you have not seen it before. They want to bring what they found back into the main work. Write the message they will send you here, in their voice, as a request:

- Say what was found and what you should do about it, in the terms of this conversation: its files, names and steps.
- Keep what matters to the main work; leave out side questions that led nowhere.
- Name files by plain paths, not @ mentions.
- Do not call tools. Be brief: a few sentences or a short list.
- Reply with the message only: no preamble, and no quotes around it.`

// How many earlier exchanges of the side thread go along with a question.
const KEPT = 20

// The system prompt when the session has no conversation to fork yet.
export const FRESH_SYSTEM =
  "You answer side questions for a user of Claude Code, the coding agent. Their main conversation has no messages yet, so answer from general knowledge, and say so when a question needs that conversation."

export function isPending(entry: Entry): boolean {
  return entry.answer === undefined && entry.error === undefined
}

export function isAnswered(entry: Entry): boolean {
  return entry.answer !== undefined
}

export function buildAsk(earlier: readonly Entry[], question: string): string {
  const parts = [RULES]
  const answered = earlier.filter(isAnswered)

  if (answered.length > 0) {
    parts.push(`Earlier in this side thread, oldest first:\n\n${exchanges(answered)}`)
  }

  parts.push(`The side question:\n\n<question>\n${question}\n</question>`)

  return parts.join('\n\n')
}

// What a hand-off sends: the answered exchanges, and what the user wants done.
export function buildHandoff(answered: readonly Entry[], wanted: string): string {
  const parts = [HANDOFF, `The side thread, oldest first:\n\n${exchanges(answered)}`]

  if (wanted !== '') {
    parts.push(`What the user wants done with it:\n\n${wanted}`)
  }

  return parts.join('\n\n')
}

function exchanges(answered: readonly Entry[]): string {
  return answered
    .slice(-KEPT)
    .map(entry => `<question>\n${entry.question}\n</question>\n<answer>\n${entry.answer}\n</answer>`)
    .join('\n\n')
}
