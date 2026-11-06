// Reads the note that You should know, a plugin built into Claude Code, puts
// in the prompt box when its card's "2: Chat in main session" is pressed:
//
//   Here is a note offered by a side agent:
//   > Heads up · <the card's line>
//   > **<title>**
//   > <explanation>
//
// The format is not API: a text this doesn't read goes to the box as before.

// The built-in plugin's name, as a `prompt.fill` origin carries it.
export const YOU_SHOULD_KNOW = 'cc-plugin-you-should-know'

const OPENING = 'Here is a note offered by a side agent:'
const TITLE = /^\*\*.+\*\*$/

export type Note = { question: string; answer: string }

export function readNote(text: string): Note | undefined {
  const [opening, ...quoted] = text.replace(/\s+$/, '').split('\n')
  if (opening?.trim() !== OPENING || quoted.some(line => line !== '>' && !line.startsWith('> '))) {
    return undefined
  }

  const [question = '', ...rest] = quoted.map(line => line.slice(2))
  const answer = paragraphs(rest).join('\n').trim()

  return question.trim() === '' || answer === '' ? undefined : { question: question.trim(), answer }
}

// The card draws a title on a row of its own; Markdown would run it into the
// line after it, so a blank line follows each.
function paragraphs(lines: readonly string[]): string[] {
  return lines.flatMap((line, at) => (TITLE.test(line.trim()) && lines[at + 1] !== '' ? [line, ''] : [line]))
}
