import type { EngineInterface } from 'claude-code'

import type { CallTime } from '../types'

type Engine = EngineInterface

// One line of the session file. Only the fields the mod reads are typed.
export type SessionEntry = {
  type?: string
  subtype?: string
  uuid?: string
  timestamp?: string
  pendingBackgroundAgentCount?: number
  origin?: { kind?: string; handback?: boolean }
  message?: { content?: unknown }
}

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string }

// The session file's id to its path, kept only once found.
const files = new Map<string, string>()
// A call's times, kept once both are found.
const times = new Map<string, CallTime>()
// An entry by its uuid, kept once found.
const byUuid = new Map<string, SessionEntry>()

// A miss is remembered this long: a late-written entry is found on the next try, but a row redrawn often doesn't grep each time.
const MISS_TTL_MS = 10_000
// Per session id: the time a missed file search may be asked again.
const fileMisses = new Map<string, number>()
// Per call id: the partial time found (if any) and the time its lookup may be asked again.
const partials = new Map<string, { time?: CallTime; retryAt: number }>()
// Per uuid: the time a missed lookup may be asked again.
const uuidMisses = new Map<string, number>()

// One JSON object per line. A line that does not parse is skipped: a cut last
// line of a truncated grep output is one.
export function parseEntries(stdout: string): SessionEntry[] {
  const entries: SessionEntry[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    try {
      const value: unknown = JSON.parse(line)
      if (value && typeof value === 'object') {
        entries.push(value as SessionEntry)
      }
    } catch {
      // A line cut short by a truncated output: skipped.
    }
  }

  return entries
}

function blocksOf(entry: SessionEntry): Block[] {
  const content = entry.message?.content
  if (!Array.isArray(content)) {
    return []
  }

  return content.filter((block): block is Block => block !== null && typeof block === 'object')
}

// The start of every tool call in these entries, and the end of every call
// with a result. A call without a start is left out.
export function callTimesFrom(entries: SessionEntry[]): Map<string, CallTime> {
  const starts = new Map<string, number>()
  const ends = new Map<string, number>()
  for (const entry of entries) {
    const at = entry.timestamp === undefined ? NaN : Date.parse(entry.timestamp)
    if (Number.isNaN(at)) {
      continue
    }
    for (const block of blocksOf(entry)) {
      if (entry.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
        starts.set(block.id, at)
      } else if (entry.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        ends.set(block.tool_use_id, at)
      }
    }
  }

  const out = new Map<string, CallTime>()
  for (const [id, start] of starts) {
    const end = ends.get(id)
    out.set(id, end === undefined ? { start } : { start, end })
  }

  return out
}

// The name of the tool a call ran, from its tool_use block.
export function toolNameFrom(entries: SessionEntry[], id: string): string | undefined {
  for (const entry of entries) {
    if (entry.type !== 'assistant') {
      continue
    }
    for (const block of blocksOf(entry)) {
      if (block.type === 'tool_use' && block.id === id && typeof block.name === 'string') {
        return block.name
      }
    }
  }

  return undefined
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
      fileMisses.set(session, now + MISS_TTL_MS)

      return null
    }
    const found = await $.process.run(['find', `${base}/projects`, '-maxdepth', '2', '-name', `${session}.jsonl`])
    const first = found.exitCode === 0 ? found.stdout.split('\n')[0] : ''
    if (!first) {
      fileMisses.set(session, now + MISS_TTL_MS)

      return null
    }
    files.set(session, first)

    return first
  } catch {
    return null
  }
}

// The session entries holding any of the needles. Nothing when the file is
// missing or grep fails.
export async function lookup($: Engine, needles: string[]): Promise<SessionEntry[]> {
  try {
    const file = await sessionFile($)
    if (file === null) {
      return []
    }
    const out = await $.process.run(['grep', '-F', ...needles.flatMap(n => ['-e', n]), file])
    if (out.exitCode !== 0) {
      return []
    }

    return parseEntries(out.stdout)
  } catch {
    return []
  }
}

// The start and end of the given calls, as the session file has them. A call
// whose two times are both found is kept for good; one that is not is looked
// up again after MISS_TTL_MS, and until then its partial time (if any) stands.
export async function historyTimes($: Engine, ids: string[]): Promise<Map<string, CallTime>> {
  const out = new Map<string, CallTime>()
  const missing: string[] = []
  const now = await $.clock.now()
  for (const id of ids) {
    const known = times.get(id)
    if (known) {
      out.set(id, known)
      continue
    }
    const partial = partials.get(id)
    if (partial && now < partial.retryAt) {
      if (partial.time) {
        out.set(id, partial.time)
      }
      continue
    }
    missing.push(id)
  }
  if (missing.length === 0) {
    return out
  }

  const entries = await lookup($, missing.flatMap(id => [`"id":"${id}"`, `"tool_use_id":"${id}"`]))
  const found = callTimesFrom(entries)
  for (const id of missing) {
    const time = found.get(id)
    if (time?.end !== undefined) {
      times.set(id, time)
      partials.delete(id)
    } else {
      partials.set(id, { time, retryAt: now + MISS_TTL_MS })
    }
    if (time) {
      out.set(id, time)
    }
  }

  return out
}

// The entry whose uuid is given, or undefined when none is found.
export async function entryByUuid($: Engine, uuid: string): Promise<SessionEntry | undefined> {
  const known = byUuid.get(uuid)
  if (known) {
    return known
  }
  const now = await $.clock.now()
  const retryAt = uuidMisses.get(uuid)
  if (retryAt !== undefined && now < retryAt) {
    return undefined
  }
  const hit = (await lookup($, [`"uuid":"${uuid}"`])).find(entry => entry.uuid === uuid)
  if (hit) {
    byUuid.set(uuid, hit)
    uuidMisses.delete(uuid)
  } else {
    uuidMisses.set(uuid, now + MISS_TTL_MS)
  }

  return hit
}
