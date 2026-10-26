// The text a side question sends the model.

import type { Entry } from '../types'

const RULES = `The user is asking a side question while you work together in this conversation. It is an aside, not part of the main task:

- Answer from what is already in this conversation: the messages, the files and command output you have seen, and the project's instructions.
- Do not call tools, and do not change course on the main work. If the answer needs something the conversation doesn't hold, say what is missing instead of guessing.
- Be brief and direct: a few sentences or a short list. Markdown is fine.
- Reply with the answer only.`

// How many earlier exchanges of the side thread go along with a question.
const KEPT = 20

// The system prompt when the session has no conversation to fork yet.
export const FRESH_SYSTEM =
  "You answer side questions for a user of Claude Code, the coding agent. Their main conversation has no messages yet, so answer from general knowledge, and say so when a question needs that conversation."

export function isPending(entry: Entry): boolean {
  return entry.answer === undefined && entry.error === undefined
}

export function buildAsk(earlier: readonly Entry[], question: string): string {
  const parts = [RULES]
  const answered = earlier.filter(entry => entry.answer !== undefined).slice(-KEPT)

  if (answered.length > 0) {
    const exchanges = answered.map(
      entry => `<question>\n${entry.question}\n</question>\n<answer>\n${entry.answer}\n</answer>`,
    )
    parts.push(`Earlier in this side thread, oldest first:\n\n${exchanges.join('\n\n')}`)
  }

  parts.push(`The side question:\n\n<question>\n${question}\n</question>`)

  return parts.join('\n\n')
}
