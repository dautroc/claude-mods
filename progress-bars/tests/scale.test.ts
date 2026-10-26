import { expect, test } from 'claude-code/testing'

import { barCells, formatDuration } from '../hooks/scale'

test('barCells grows on a log scale and reaches 40 at ten minutes', () => {
  expect([0, 200, 1_000, 10_000, 60_000, 600_000, 3_600_000].map(ms => barCells(ms))).toEqual([1, 1, 4, 15, 26, 40, 40])
  expect(barCells(600_000, 20)).toBe(20)
  expect(barCells(1_000, 0)).toBe(1)
})

test('formatDuration matches the engine', () => {
  expect([999, 1_000, 59_999, 64_000, 3_720_000].map(formatDuration)).toEqual(['<1s', '1s', '59s', '1m 4s', '1h 2m'])
})
