import type { SessionMessage, ToolUseSummary } from 'claude-code'

// This mod's command, whose runs are left out.
const COMMAND = 'transcript'

// $.session.messages() hands a mod the newest this many, no more.
export const MAX_ROWS = 4096

// How the engine opens the user row that stands for compacted turns.
const SUMMARY_OPENING = 'This session is being continued from a previous conversation'

// User rows the engine writes, not the person: a command's output and the
// caveat above it, a ! command's output, a loaded skill's body (its Skill
// call already has a line), a background task's report.
const ENGINE_ROWS = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<bash-stdout>',
  '<bash-stderr>',
  'Base directory for this skill:',
  '<task-notification>',
]

// The input a tool is best known by, tried in order; a tool with none of
// them shows its first string input.
const NAMING_INPUTS = ['command', 'file_path', 'notebook_path', 'url', 'query', 'pattern', 'path', 'skill', 'description', 'prompt']

const INPUT_MAX = 120

export type Transcript = {
  markdown: string
  // The newest prompt's heading, counted from 1: where nvim opens.
  line: number
}

type Prompt = { kind: 'prompt' | 'summary' | 'interrupted'; text: string }

export function toMarkdown(rows: readonly SessionMessage[], title: string): Transcript {
  const lines = [`# ${title}`]
  if (rows.length >= MAX_ROWS) {
    lines.push('', `> Earlier messages are left out: Claude Code hands a mod only the newest ${MAX_ROWS}.`)
  }

  let newest = 1
  let isClaudes = false
  // Whether the last line is a tool's, so the next tool line joins its list.
  let isListing = false

  for (const row of rows) {
    if (row.role === 'user') {
      const prompt = promptOf(row)
      if (prompt === undefined) {
        continue
      }
      if (prompt.kind === 'interrupted') {
        lines.push('', '_Interrupted._')
        isListing = false
        continue
      }

      lines.push('', prompt.kind === 'summary' ? '## Summary of earlier turns' : '## You')
      if (prompt.kind === 'prompt') {
        newest = lines.length
      }
      lines.push('', prompt.text)
      isClaudes = false
      isListing = false
      continue
    }

    const text = row.text.trim()
    if (text === '' && row.toolUses.length === 0) {
      continue
    }
    if (!isClaudes) {
      lines.push('', '## Claude')
      isClaudes = true
      isListing = false
    }
    if (text !== '') {
      lines.push('', text)
      isListing = false
    }
    for (const use of row.toolUses) {
      if (!isListing) {
        lines.push('')
      }
      lines.push(toolLine(use))
      isListing = true
    }
  }

  return { markdown: `${lines.join('\n')}\n`, line: newest }
}

function promptOf(row: SessionMessage): Prompt | undefined {
  const text = row.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (text === '' || ENGINE_ROWS.some(opening => text.startsWith(opening))) {
    return undefined
  }
  if (text.startsWith('[Request interrupted by user')) {
    return { kind: 'interrupted', text }
  }
  if (text.startsWith(SUMMARY_OPENING)) {
    return { kind: 'summary', text }
  }

  const command = /^<command-name>\/?([^<]*)<\/command-name>/.exec(text)
  if (command !== null) {
    const name = command[1] ?? ''
    if (name === COMMAND) {
      return undefined
    }
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? ''

    return { kind: 'prompt', text: args === '' ? `/${name}` : `/${name} ${args}` }
  }

  const shell = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)
  if (shell !== null) {
    return { kind: 'prompt', text: `! ${shell[1]?.trim() ?? ''}` }
  }

  return { kind: 'prompt', text }
}

function toolLine(use: ToolUseSummary): string {
  const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
  const named = NAMING_INPUTS.map(key => use.input[key]).find(isText) ?? Object.values(use.input).find(isText)
  const what = named === undefined ? '' : `: ${code(oneLine(named))}`

  return `- ${use.tool}${what}${use.isError ? ' (failed)' : ''}`
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > INPUT_MAX ? `${flat.slice(0, INPUT_MAX - 1)}…` : flat
}

// Inline code, fenced with one backtick more than the longest run inside.
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(longest + 1)

  return longest === 0 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`
}
