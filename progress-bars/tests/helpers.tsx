import type { AgentStatus, On } from 'claude-code'
import type { Engine, Mounted } from 'claude-code/testing'

import { INDEX_PATTERN } from '../hooks/history'

// What the engine draws for a row when the plugin passes.
export function engine(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

// A bar's drawing: the run of ▰ (its count and colour), then the time.
export async function readBar(ui: Mounted) {
  const [glyphs, time] = await ui.findAll({ type: 'Text' })
  if (!glyphs || !time) {
    throw new Error('no bar drawn: expected a run of glyphs and a time')
  }

  return { glyphs: glyphs.text.length, color: glyphs.props.color, time: time.text.trim() }
}

export function iso(ms: number) {
  return new Date(ms).toISOString()
}

// A uuid for tests: `uid(7)` is 00000000-0000-0000-0000-000000000007.
export function uid(n: number) {
  return `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
}

let counter = 1000
function freshUuid() {
  return uid(++counter)
}

// Session file lines, in the key order the real file uses (Claude Code 2.1.310).

// An assistant line holding tool_use blocks, then its uuid and timestamp.
export function toolUsesLine(calls: readonly (readonly [id: string, name: string])[], at: number, uuid = freshUuid()) {
  const content = calls.map(([id, name]) => ({ type: 'tool_use', id, name, input: {} }))

  return JSON.stringify({ parentUuid: 'p', isSidechain: false, message: { role: 'assistant', content }, type: 'assistant', uuid, timestamp: iso(at) })
}

export function toolUseLine(id: string, name: string, at: number, uuid = freshUuid()) {
  return toolUsesLine([[id, name]], at, uuid)
}

// A user line holding tool_result blocks (`type` first), then its uuid and timestamp.
export function toolResultLine(id: string, at: number, uuid = freshUuid()) {
  const content = [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]

  return JSON.stringify({ parentUuid: 'p', isSidechain: false, message: { role: 'user', content }, uuid, timestamp: iso(at), toolUseResult: {} })
}

// A turn_duration line: `pendingBackgroundAgentCount` is absent when 0, and `timestamp` comes before `uuid`.
export function turnLine(uuid: string, at: number, pending: number) {
  return JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    durationMs: 10_000,
    messageCount: 2,
    ...(pending > 0 ? { pendingBackgroundAgentCount: pending } : {}),
    timestamp: iso(at),
    uuid,
  })
}

// A saved prompt line: top-level uuid and timestamp, then the origin.
export function promptLine(uuid: string, origin: Record<string, unknown>, at = 0) {
  return JSON.stringify({ uuid, timestamp: iso(at), type: 'user', origin, message: { role: 'user', content: 'hi' } })
}

// A real session-file sample and what the real `/usr/bin/grep -a -n -b -o -E` printed for it (macOS, BSD grep 2.6.0),
// run with INDEX_PATTERN. Its last line quotes escaped ids that must not count. Line 2 holds a multi-byte character.
export const REAL_LINES = [
  "{\"parentUuid\":\"p0\",\"isSidechain\":false,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_AAA\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}},{\"type\":\"tool_use\",\"id\":\"toolu_BBB\",\"name\":\"Agent\",\"input\":{}}]},\"type\":\"assistant\",\"uuid\":\"11111111-1111-1111-1111-111111111111\",\"timestamp\":\"2026-10-26T10:00:00.000Z\"}",
  "{\"parentUuid\":\"11111111-1111-1111-1111-111111111111\",\"isSidechain\":false,\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_AAA\",\"content\":\"é ok\"},{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_BBB\",\"content\":\"launched\"}]},\"uuid\":\"22222222-2222-2222-2222-222222222222\",\"timestamp\":\"2026-10-26T10:00:02.500Z\",\"toolUseResult\":{\"x\":1}}",
  "{\"type\":\"system\",\"subtype\":\"turn_duration\",\"durationMs\":5000,\"messageCount\":3,\"pendingBackgroundAgentCount\":1,\"timestamp\":\"2026-10-26T10:00:05.000Z\",\"uuid\":\"33333333-3333-3333-3333-333333333333\",\"isMeta\":false}",
  "{\"type\":\"system\",\"subtype\":\"turn_duration\",\"durationMs\":7000,\"messageCount\":4,\"timestamp\":\"2026-10-26T10:00:20.000Z\",\"uuid\":\"44444444-4444-4444-4444-444444444444\",\"isMeta\":false}",
  "{\"uuid\":\"55555555-5555-5555-5555-555555555555\",\"timestamp\":\"2026-10-26T10:00:30.000Z\",\"type\":\"user\",\"origin\":{\"kind\":\"peer\",\"from\":\"a\",\"handback\":true},\"message\":{\"role\":\"user\",\"content\":\"report\"}}",
  "{\"parentUuid\":\"p9\",\"message\":{\"role\":\"user\",\"content\":\"quote \\\"tool_use_id\\\":\\\"toolu_X\\\" and \\\"id\\\":\\\"toolu_Y\\\",\\\"name\\\":\\\"Bash\\\"\"},\"type\":\"user\",\"uuid\":\"66666666-6666-6666-6666-666666666666\",\"timestamp\":\"2026-10-26T10:00:40.000Z\"}",
]

export const REAL_GREP_OUTPUT = "1:99:\"id\":\"toolu_AAA\",\"name\":\"Bash\"\n1:175:\"id\":\"toolu_BBB\",\"name\":\"Agent\"\n1:240:\"uuid\":\"11111111-1111-1111-1111-111111111111\",\"timestamp\":\"2026-10-26T10:00:00.000Z\"\n2:457:\"tool_use_id\":\"toolu_AAA\"\n2:524:\"tool_use_id\":\"toolu_BBB\"\n2:574:\"uuid\":\"22222222-2222-2222-2222-222222222222\",\"timestamp\":\"2026-10-26T10:00:02.500Z\"\n3:701:\"subtype\":\"turn_duration\",\"durationMs\":5000,\"messageCount\":3,\"pendingBackgroundAgentCount\":1,\"timestamp\":\"2026-10-26T10:00:05.000Z\",\"uuid\":\"33333333-3333-3333-3333-333333333333\",\"isMeta\":false\n4:912:\"subtype\":\"turn_duration\",\"durationMs\":7000,\"messageCount\":4,\"timestamp\":\"2026-10-26T10:00:20.000Z\",\"uuid\":\"44444444-4444-4444-4444-444444444444\",\"isMeta\":false\n5:1075:\"uuid\":\"55555555-5555-5555-5555-555555555555\",\"timestamp\":\"2026-10-26T10:00:30.000Z\"\n5:1209:\"handback\":true\n6:1418:\"uuid\":\"66666666-6666-6666-6666-666666666666\",\"timestamp\":\"2026-10-26T10:00:40.000Z\"\n"


const encoder = new TextEncoder()

// A string's length in UTF-8 bytes, which is what grep's -b counts.
export function byteLength(text: string): number {
  return encoder.encode(text).length
}

// Prints what `grep -n -b -o -E INDEX_PATTERN` prints for a file, from `from` byte on:
// `<line>:<byte>:<match>`, with lines and bytes counted from there.
export function indexOutput(text: string, from = 0): string {
  const body = new TextDecoder().decode(encoder.encode(text).subarray(from))
  const out: string[] = []
  let lineStart = 0
  body.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(new RegExp(INDEX_PATTERN, 'g'))) {
      out.push(`${i + 1}:${lineStart + byteLength(line.slice(0, m.index))}:${m[0]}\n`)
    }
    lineStart += byteLength(line) + 1
  })

  return out.join('')
}

// How the fake process runner answers.
export type Answers = {
  // The session file's text, or a function giving it as it changes; `find` finds the file unless `find` is set.
  text?: string | (() => string)
  find?: string
  // ripgrep: 'ok' (default), 'throws', or an exit code.
  rg?: 'ok' | 'throws' | number
  grepExit?: number
  // Every process call throws.
  throws?: boolean
  // The stdout is cut to this many characters and flagged truncated.
  cutAt?: number
}

// Answers `find`, `rg`, `grep` and the `sh`/`tail` scan the way the real tools would for the session file
// (see indexOutput). Returns every command the engine ran, as its argv.
export function answerProcesses(on: On, session: string, answers: Answers = {}) {
  const ran: string[][] = []
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    ran.push(argv)
    if (answers.throws) {
      throw new Error('cannot start')
    }
    const done = (exitCode: number, stdout: string) => {
      const cut = answers.cutAt !== undefined && stdout.length > answers.cutAt
      const out = cut ? stdout.slice(0, answers.cutAt) : stdout

      return { value: { exitCode, stdout: out, stderr: '', isStdoutTruncated: cut, isStderrTruncated: false } }
    }
    const text = typeof answers.text === 'function' ? answers.text() : (answers.text ?? '')
    const scan = (from: number, exit?: number) => {
      const out = indexOutput(text, from)

      return done(exit ?? (out === '' ? 1 : 0), out)
    }
    switch (argv[0]) {
      case 'find':
        return done(0, answers.find ?? `/home/u/.claude/projects/p/${session}.jsonl\n`)
      case 'rg':
        if (answers.rg === 'throws') {
          throw new Error('rg: not found')
        }

        return typeof answers.rg === 'number' ? done(answers.rg, '') : scan(0)
      case 'grep':
        return scan(0, answers.grepExit)
      case 'sh':
        return scan(Number(argv[4]) - 1, answers.grepExit)
      default:
        return done(2, '')
    }
  })

  return ran
}

export function sessionOn(on: On, session: string) {
  on('session.id', () => ({ value: session }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
}

// What `$.agent.list()` says of the launched agent: `status` null drops it from the list.
export type Listing = { status: AgentStatus | null }

// Launches a background agent from the main loop, which returns at once, and answers `$.agent.list()` with
// it as `listing` says (running by default). Returns the tool call that started it.
export async function launchAgent($: Engine, on: On, agentId: string, listing: Listing = { status: 'running' }) {
  let toolUseId = ''
  on('tool.call', { tool: 'Agent' }, (_, e) => {
    toolUseId = e.tool_use_id

    return { result: { status: 'async_launched', agentId, description: 'd' } }
  })
  on('agent.list', () => ({
    value: listing.status === null ? [] : [{ id: agentId, description: 'd', type: 'general-purpose', status: listing.status }],
  }))
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)

  return toolUseId
}
