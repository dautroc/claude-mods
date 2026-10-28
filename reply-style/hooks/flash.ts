import type { Copyable } from './markdown'

// The letters a hint takes, home row first, as flash.nvim's do.
export const LETTERS = 'asdfghjklqwertyuiopzxcvbnm'

// A reply row on screen with a copy button: when it was first drawn, which
// orders it in the transcript, and the blocks its buttons copy, in order.
export type Row = { order: number; blocks: Copyable[] }

export type Hints = {
  // Each row's letters, by button number; '' for a button left without one.
  letters: Record<string, string[]>
  // The block each letter copies.
  targets: Map<string, Copyable>
}

// Gives the buttons on screen a letter each, nearest the prompt first: the
// newest row's last button takes `a`, so the block just written is a
// home-row key away. Buttons past the 26th get none.
export function hint(rows: ReadonlyMap<string, Row>): Hints {
  const letters: Record<string, string[]> = {}
  const targets = new Map<string, Copyable>()
  let next = 0
  for (const [id, row] of [...rows].sort((a, b) => b[1].order - a[1].order)) {
    const each = row.blocks.map(() => '')
    for (let n = row.blocks.length - 1; n >= 0 && next < LETTERS.length; n--) {
      const letter = LETTERS[next++]!
      each[n] = letter
      targets.set(letter, row.blocks[n]!)
    }
    letters[id] = each
  }

  return { letters, targets }
}
