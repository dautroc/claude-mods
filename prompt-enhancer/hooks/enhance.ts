// The text the enhancer sends the model, and what it reads back.

export type InstructionFile = { path: string; text: string }
export type Command = { name: string; description: string }

const INSTRUCTIONS = `The user is drafting their next message to Claude Code in the prompt box and has not sent it yet. Do not answer it, do not act on it, and do not call any tools. Rewrite it into the message they would write with more time: the same request, made specific enough that Claude Code could act on it without guessing.

- Keep their goal and scope. Add no features, steps or requirements they did not ask for.
- Resolve vague words ("it", "this", "that bug", "like before", "the usual way") from the conversation so far, the project's instructions and the files read so far. Name the concrete file, function, command, error or earlier decision they point to, but only when the context makes it clear. Never invent paths or names.
- If one of the skills, slash commands or tools available in this session clearly fits, name it.
- Say what done looks like when the context makes it clear: what should change, and how to check it, such as the test or command to run.
- If something stays ambiguous and the answer would change the work, add one short line asking to confirm that point first instead of guessing.
- Don't restate the project's standing instructions; Claude Code already follows them.
- Write as the user, in the first person, in the draft's language. Keep it short: usually 2 to 8 lines of plain text, a few bullets at most, no headings, no preamble.
- Refer to files by their path, without @.
- If the draft is already clear and specific, return it as it is, or with the smallest fix.

Reply with the rewritten message only, inside <prompt></prompt> tags.`

const FILE_CAP = 30_000
const COMMAND_CAP = 150
const DESCRIPTION_CAP = 200

export function buildAsk(draft: string): string {
  return `${INSTRUCTIONS}\n\n<draft>\n${draft}\n</draft>`
}

// The rewritten prompt out of the model's reply: what the <prompt> tags hold,
// else the whole reply, without a code fence wrapped around it.
export function extractPrompt(reply: string): string {
  const tagged = /<prompt>([\s\S]*?)<\/prompt>/i.exec(reply)
  const body = (tagged?.[1] ?? reply).trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(body)

  return (fenced?.[1] ?? body).trim()
}

// The instruction files Claude Code would load for `root`: the user's own,
// then each folder's from the top of the disk down to the project root.
export function instructionPaths(home: string, root: string): string[] {
  const paths = home === '' ? [] : [`${home}/.claude/CLAUDE.md`]
  const parts = root.split('/').filter(part => part !== '')

  for (let depth = 0; depth <= parts.length; depth += 1) {
    const dir = `/${parts.slice(0, depth).join('/')}`.replace(/\/$/, '')
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', 'AGENTS.md']) {
      paths.push(`${dir}/${name}`)
    }
  }

  return [...new Set(paths)]
}

// The system prompt for a session with no turn to fork yet: what Claude Code
// will know when it reads the prompt.
export function projectContext(
  root: string,
  files: readonly InstructionFile[],
  commands: readonly Command[],
): string {
  const sections = [
    'You sharpen prompts for Claude Code, the coding agent the user works with. Below is what that agent will know when it reads the prompt.',
    `Project root: ${root}`,
  ]

  for (const file of files) {
    sections.push(`<instructions path="${file.path}">\n${clip(file.text, FILE_CAP)}\n</instructions>`)
  }

  if (commands.length > 0) {
    const lines = commands
      .slice(0, COMMAND_CAP)
      .map(command => `- /${command.name}: ${clip(command.description, DESCRIPTION_CAP)}`)
    sections.push(`Skills and slash commands available:\n${lines.join('\n')}`)
  }

  return sections.join('\n\n')
}

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text
}
