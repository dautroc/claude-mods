import { atom } from 'claude-code'

// Change the tag when the stored values change meaning: the code declines
// what an earlier version wrote, which outlives a reload.
export const SHAPE = 'progress-bars-1'

const shaped = { shape: SHAPE }

// The timing of one tool call, by its tool_use_id.
export function callTime(id: string) {
  return atom({ plugin: 'progress-bars', key: 'calls', id } as const, null, shaped)
}

export const agents = atom({ plugin: 'progress-bars', key: 'agents' } as const, [], shaped)
export const turnStarts = atom({ plugin: 'progress-bars', key: 'turnStarts' } as const, [], shaped)
export const now = atom({ plugin: 'progress-bars', key: 'now' } as const, 0)
