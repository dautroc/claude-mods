import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { SHAPE } from './state'
import type { AgentRun } from '../types'

type Engine = EngineInterface

// How often the ticker writes the clock while anything is open.
const PERIOD_MS = 500
// A background agent with no end counts as open for this long after it started.
const AGENT_WINDOW_MS = 6 * 60 * 60 * 1000

// Read by the drawing so a running bar grows; this module writes it.
const now = atom({ plugin: 'progress-bars', key: 'now' } as const, 0)
// The background agents the register hooks record.
const agents = atom({ plugin: 'progress-bars', key: 'agents' } as const, [] as AgentRun[], { shape: SHAPE })

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
  let runs = await read($, agents)
  if (runs.some(run => run.end === undefined)) {
    runs = await settleLost($, runs, at)
  }

  return runs.some(run => run.end === undefined && run.start > at - AGENT_WINDOW_MS)
}

// An agent whose end never arrived (its turn.complete was missed, say) is read
// off $.agent.list(): listed as completed, failed or killed, it ended with that
// outcome; no longer listed, it ended and draws as done. Returns the runs as they stand.
async function settleLost($: Engine, runs: AgentRun[], at: number): Promise<AgentRun[]> {
  try {
    const listed = await $.agent.list()
    const settled = new Map<string, Pick<AgentRun, 'end' | 'outcome'>>()
    for (const run of runs) {
      if (run.end !== undefined) {
        continue
      }
      const info = listed.find(agent => agent.id === run.id)
      if (info === undefined) {
        settled.set(run.id, { end: at })
      } else if (info.status === 'completed' || info.status === 'failed' || info.status === 'killed') {
        settled.set(run.id, { end: at, outcome: info.status })
      }
    }
    if (settled.size === 0) {
      return runs
    }
    const apply = (all: readonly AgentRun[]) =>
      all.map(run => (run.end === undefined && settled.has(run.id) ? { ...run, ...settled.get(run.id) } : run))
    await update($, agents, all => apply(all))

    return apply(runs)
  } catch {
    // The ticker goes on as before.
    return runs
  }
}
