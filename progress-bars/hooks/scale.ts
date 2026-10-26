// The most cells a bar draws: a ten-minute run fills it.
export const MAX_CELLS = 40

// Log scale from one second to ten minutes: 1 cell at the least, MAX_CELLS at ten minutes and beyond.
export function barCells(ms: number, maxCells = MAX_CELLS): number {
  if (maxCells < 1) {
    return 1
  }

  const cells = Math.round((maxCells * Math.log(1 + ms / 1000)) / Math.log(601))

  return Math.max(1, Math.min(maxCells, cells))
}

// Whole seconds, as the engine words a duration.
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 1) {
    return '<1s'
  }
  if (seconds < 60) {
    return `${seconds}s`
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  }

  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}
