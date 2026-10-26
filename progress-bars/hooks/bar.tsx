import type { EngineInterface, RenderInput, ThemeKey } from 'claude-code'

import { MAX_CELLS, barCells, formatDuration } from './scale'

export type BarTone = 'running' | 'done' | 'failed' | 'stopped'

export const TONE_COLOR: Record<BarTone, ThemeKey> = {
  running: 'claude',
  done: 'success',
  failed: 'error',
  stopped: 'warning',
}

// Running first, then an abort, then an error: an interrupted call that also
// errored reads as stopped.
export function toneOf(row: { isRunning: boolean; isErrored: boolean; isInterrupted: boolean }): BarTone {
  if (row.isRunning) {
    return 'running'
  }
  if (row.isInterrupted) {
    return 'stopped'
  }
  if (row.isErrored) {
    return 'failed'
  }

  return 'done'
}

// The bar for a row's time, indented two cells with the time after one space.
// The glyphs shrink to fit the terminal's width.
export function drawBar($: EngineInterface, e: RenderInput<'ToolUse' | 'ToolResult' | 'ToolGroup'>, ms: number, tone: BarTone) {
  const { Box, Text } = $.ui.resolve(e)
  const label = ' ' + formatDuration(ms)
  const columns = e.viewport?.columns ?? 80
  const cells = barCells(ms, Math.min(MAX_CELLS, columns - 4 - label.length))

  return (
    <Box paddingLeft={2}>
      <Text color={TONE_COLOR[tone]}>{'▰'.repeat(cells)}</Text>
      <Text dimColor>{label}</Text>
    </Box>
  )
}

// The result block under a bar draws nothing: the bar already stands for the
// call.
export function drawNothing($: EngineInterface, e: RenderInput<'ToolUse' | 'ToolResult' | 'ToolGroup'>) {
  const { Box } = $.ui.resolve(e)

  return <Box />
}
