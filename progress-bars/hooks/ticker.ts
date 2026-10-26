import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { SHAPE } from './state'

type Engine = EngineInterface

// How often the ticker writes the clock while anything is open.
const PERIOD_MS = 500
// A background agent with no end counts as open for this long after it started.
const AGENT_WINDOW_MS = 6 * 60 * 60 * 1000

// Read by the drawing so a running bar grows; this module writes it.
const now = atom({ plugin: 'progress-bars', key: 'now' } as const, 0)
// The background agents; nothing writes them yet.
const agents = atom({ plugin: 'progress-bars', key: 'agents' } as const, [], { shape: SHAPE })

// The main-loop calls that have started and not yet ended.
const open = new Set<string>()
let timer: { cancel: () => void } | undefined

export function markStarted(id: string): void {
  open.add(id)
}

export function markEnded(id: string): void {
  open.delete(id)
}

// Starts the ticker unless it runs already.
export function ensureTicking($: Engine): void {
  if (timer !== undefined) {
    return
  }
  timer = $.clock.every(PERIOD_MS, () => tick($))
}

function stop(): void {
  timer?.cancel()
  timer = undefined
}

// Writes the clock while anything is open, and otherwise stops the timer.
export async function tick($: Engine): Promise<void> {
  try {
    const at = await $.clock.now()
    if (open.size === 0 && !(await agentOpen($, at))) {
      // A call may have started during the reads above: stop only if none did.
      if (open.size === 0) {
        stop()

        return
      }
    }
    await update($, now, () => at)
  } catch {
    // The ticker is a drawing aid: a fault here leaves the bars as they were.
  }
}

async function agentOpen($: Engine, at: number): Promise<boolean> {
  const runs = await read($, agents)

  return runs.some(run => run.end === undefined && run.start > at - AGENT_WINDOW_MS)
}
