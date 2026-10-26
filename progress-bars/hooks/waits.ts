import type { BarTone } from './bar'
import type { AgentRun } from '../types'

export type Wait = { ms: number; tone: BarTone }

// How long a turn's footer waits on the background agents it left running, and
// how that wait ended. Undefined when none was out at the turn's end.
export function waitFor(turnEnd: number, runs: readonly AgentRun[], starts: readonly number[], at: number): Wait | null {
  const out = runs.filter(run => run.start < turnEnd && (run.end === undefined || run.end > turnEnd))
  if (out.length === 0) {
    return null
  }

  // The wait ends at the next turn's start, or once every agent out has ended,
  // whichever comes first.
  const ends: number[] = []
  const next = starts.filter(start => start > turnEnd)
  if (next.length > 0) {
    ends.push(Math.min(...next))
  }
  if (out.every(run => run.end !== undefined)) {
    ends.push(Math.max(...out.map(run => run.end as number)))
  }
  if (ends.length === 0) {
    return { ms: at - turnEnd, tone: 'running' }
  }

  const waitEnd = Math.min(...ends)
  const ended = out.filter(run => run.end !== undefined && run.end <= waitEnd)

  return { ms: waitEnd - turnEnd, tone: toneOfWait(ended) }
}

function toneOfWait(ended: readonly AgentRun[]): BarTone {
  if (ended.some(run => run.outcome === 'failed')) {
    return 'failed'
  }
  if (ended.some(run => run.outcome === 'killed')) {
    return 'stopped'
  }

  return 'done'
}
