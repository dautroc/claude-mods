import type { EngineInterface } from 'claude-code'

import type { CallTime } from '../types'

type Engine = EngineInterface

// What the mod knows of one session file: every tool call's times and name,
// every turn_duration line, and the uuids of the hand-back entries.
export type SessionIndex = {
  calls: Map<string, { start?: number; end?: number; name?: string }>
  // A turn_duration entry by its uuid: its timestamp and the background agents it left running (0 when absent).
  turns: Map<string, { at: number; pending: number }>
  handbacks: Set<string>
}

// One pass over the file finds everything the index holds. Session files reach well over 100 MB,
// so this is a single regex with -o: its cost does not grow with what it looks for.
export const INDEX_PATTERN =
  '"id":"toolu_[A-Za-z0-9_]+","name":"[^"]+"|"tool_use_id":"toolu_[A-Za-z0-9_]+"|"uuid":"[0-9a-f-]{36}","timestamp":"[^"]+"|"subtype":"turn_duration"[^}]*|"handback":true'

// A scan does not start within this long of the last one's start.
export const REFRESH_MS = 1_000
// A missed file search is remembered this long.
const FILE_MISS_MS = 10_000

// The session file's id to its path, kept only once found.
const files = new Map<string, string>()
// Per session id: the time a missed file search may be asked again.
const fileMisses = new Map<string, number>()

type Scan = {
  index: SessionIndex
  // Absolute byte offset the next scan starts from; undefined before the first scan reads anything.
  offset?: number
  // When the last scan started.
  startedAt?: number
  running?: Promise<void>
}
// One scan state per session id.
const scans = new Map<string, Scan>()

function emptyIndex(): SessionIndex {
  return { calls: new Map(), turns: new Map(), handbacks: new Set() }
}

type Match = { line: number; byte: number; text: string }

function matchesOf(stdout: string): Match[] {
  const out: Match[] = []
  for (const row of stdout.split('\n')) {
    const m = /^(\d+):(\d+):(.*)$/s.exec(row)
    if (m) {
      out.push({ line: Number(m[1]), byte: Number(m[2]), text: m[3] as string })
    }
  }

  return out
}

const STAMP = /^"uuid":"([0-9a-f-]{36})","timestamp":"([^"]+)"$/

// Reads `grep -n -b -o` output (`<line>:<byte>:<match>`) into the index. `base` is the file offset the
// output's bytes are counted from. Returns the absolute offset of the last uuid/timestamp match, where the
// next scan starts; undefined when there was none. A call or entry already in the index keeps its first values.
export function parseIndex(stdout: string, base: number, into: SessionIndex): number | undefined {
  let last: number | undefined
  const groups = new Map<number, Match[]>()
  for (const match of matchesOf(stdout)) {
    const group = groups.get(match.line)
    if (group) {
      group.push(match)
    } else {
      groups.set(match.line, [match])
    }
  }

  for (const group of groups.values()) {
    const turn = group.find(match => match.text.startsWith('"subtype":"turn_duration"'))
    if (turn) {
      const at = /"timestamp":"([^"]+)"/.exec(turn.text)?.[1]
      const uuid = /"uuid":"([0-9a-f-]{36})"/.exec(turn.text)?.[1]
      const pending = Number(/"pendingBackgroundAgentCount":(\d+)/.exec(turn.text)?.[1] ?? 0)
      const ms = at === undefined ? NaN : Date.parse(at)
      if (uuid !== undefined && !Number.isNaN(ms) && !into.turns.has(uuid)) {
        into.turns.set(uuid, { at: ms, pending })
      }
      continue
    }

    let uuid: string | undefined
    let at = NaN
    for (const match of group) {
      const stamp = STAMP.exec(match.text)
      if (stamp) {
        uuid = stamp[1]
        at = Date.parse(stamp[2] as string)
        last = base + match.byte
      }
    }
    if (uuid === undefined || Number.isNaN(at)) {
      continue
    }
    for (const match of group) {
      const started = /^"id":"(toolu_[A-Za-z0-9_]+)","name":"([^"]+)"$/.exec(match.text)
      const ended = /^"tool_use_id":"(toolu_[A-Za-z0-9_]+)"$/.exec(match.text)
      if (started) {
        const call = into.calls.get(started[1] as string) ?? {}
        call.start ??= at
        call.name ??= started[2]
        into.calls.set(started[1] as string, call)
      } else if (ended) {
        const call = into.calls.get(ended[1] as string) ?? {}
        call.end ??= at
        into.calls.set(ended[1] as string, call)
      } else if (match.text === '"handback":true') {
        into.handbacks.add(uuid)
      }
    }
  }

  return last
}

// The session file's path: found under the config directory's projects, which
// is CLAUDE_CONFIG_DIR or ~/.claude. Undefined when none is found.
export async function sessionFile($: Engine): Promise<string | null> {
  try {
    const session = await $.session.id()
    const known = files.get(session)
    if (known !== undefined) {
      return known
    }
    const now = await $.clock.now()
    const retryAt = fileMisses.get(session)
    if (retryAt !== undefined && now < retryAt) {
      return null
    }
    const configured = await $.env.get('CLAUDE_CONFIG_DIR')
    const home = configured === undefined ? await $.env.get('HOME') : undefined
    const base = configured ?? (home === undefined ? undefined : `${home}/.claude`)
    if (base === undefined) {
      fileMisses.set(session, now + FILE_MISS_MS)

      return null
    }
    const found = await $.process.run(['find', `${base}/projects`, '-maxdepth', '2', '-name', `${session}.jsonl`])
    const first = found.exitCode === 0 ? found.stdout.split('\n')[0] : ''
    if (!first) {
      fileMisses.set(session, now + FILE_MISS_MS)

      return null
    }
    files.set(session, first)

    return first
  } catch {
    return null
  }
}


// The first scan reads the whole file: ripgrep when it runs, else grep.
async function firstScan($: Engine, file: string) {
  try {
    const out = await $.process.run(['rg', '--no-config', '-a', '-n', '-b', '-o', '-e', INDEX_PATTERN, file])
    if (out.exitCode === 0 || out.exitCode === 1) {
      return out
    }
  } catch {
    // No ripgrep here: grep reads it instead.
  }

  return $.process.run(['grep', '-a', '-n', '-b', '-o', '-E', INDEX_PATTERN, file])
}

// Later scans read from the stored offset on.
function laterScan($: Engine, file: string, offset: number) {
  return $.process.run(['sh', '-c', 'tail -c +"$1" "$2" | grep -a -n -b -o -E "$3"', 'sh', String(offset + 1), file, INDEX_PATTERN])
}

async function scanOnce($: Engine, state: Scan): Promise<void> {
  try {
    const file = await sessionFile($)
    if (file === null) {
      return
    }
    const base = state.offset ?? 0
    const out = state.offset === undefined ? await firstScan($, file) : await laterScan($, file, state.offset)
    if (out.exitCode !== 0 && out.exitCode !== 1) {
      return
    }
    // A truncated output may end mid-match: its last line is dropped.
    const whole = out.stdout.endsWith('\n') ? out.stdout.slice(0, -1) : out.stdout
    const stdout = out.isStdoutTruncated ? whole.slice(0, Math.max(0, whole.lastIndexOf('\n'))) : out.stdout
    const next = parseIndex(stdout, base, state.index)
    if (next !== undefined) {
      state.offset = next
    }
  } catch {
    // A failed scan leaves the index and offset as they were.
  }
}

async function stateOf($: Engine): Promise<Scan> {
  const session = await $.session.id()
  let state = scans.get(session)
  if (!state) {
    state = { index: emptyIndex() }
    scans.set(session, state)
  }

  return state
}

// Reads what the session file gained since the last scan. One scan runs at a time and callers
// that arrive meanwhile share it; none starts within REFRESH_MS of the last one's start.
async function refresh($: Engine): Promise<Scan> {
  const state = await stateOf($)
  const now = await $.clock.now()
  // No await from here to the assignment: two callers cannot both start a scan.
  if (state.running) {
    await state.running

    return state
  }
  if (state.startedAt === undefined || now >= state.startedAt + REFRESH_MS) {
    state.startedAt = now
    state.running = scanOnce($, state).finally(() => {
      state.running = undefined
    })
    await state.running
  }

  return state
}

// Starts the first scan without waiting for it, so rows drawn after a resume find the index ready.
export async function warm($: Engine): Promise<void> {
  try {
    await refresh($)
  } catch {
    // Warming is an aid: a fault leaves the lookups to scan on demand.
  }
}

// The start and end of the given calls. Runs one refresh first if any lacks its end; times found
// partly are returned as found.
export async function callTimes($: Engine, ids: string[]): Promise<Map<string, CallTime>> {
  const out = new Map<string, CallTime>()
  try {
    let state = await stateOf($)
    if (ids.some(id => state.index.calls.get(id)?.end === undefined)) {
      state = await refresh($)
    }
    for (const id of ids) {
      const call = state.index.calls.get(id)
      if (call?.start !== undefined) {
        out.set(id, call.end === undefined ? { start: call.start } : { start: call.start, end: call.end })
      }
    }
  } catch {
    // A failed lookup answers what it has.
  }

  return out
}

// A turn_duration entry by its uuid, or undefined when the file has none.
export async function turnEntry($: Engine, uuid: string): Promise<{ at: number; pending: number } | undefined> {
  try {
    let state = await stateOf($)
    if (!state.index.turns.has(uuid)) {
      state = await refresh($)
    }

    return state.index.turns.get(uuid)
  } catch {
    return undefined
  }
}

// Whether the entry with this uuid is an agent's hand-back report.
export async function isHandback($: Engine, uuid: string): Promise<boolean> {
  try {
    let state = await stateOf($)
    if (!state.index.handbacks.has(uuid)) {
      state = await refresh($)
    }

    return state.index.handbacks.has(uuid)
  } catch {
    return false
  }
}

// The name of the tool a call ran, by its id, or undefined when the file has none.
export async function toolNameOf($: Engine, id: string): Promise<string | undefined> {
  try {
    let state = await stateOf($)
    if (state.index.calls.get(id)?.name === undefined) {
      state = await refresh($)
    }

    return state.index.calls.get(id)?.name
  } catch {
    return undefined
  }
}
