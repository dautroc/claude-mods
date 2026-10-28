import type { Diagram } from '../types'

// A terminal cell is about twice as tall as it is wide, and about 16 pixels
// wide in the picture, which render/mermaid.mjs draws at twice the SVG's size.
const CELL_ASPECT = 2
const PIXELS_PER_COLUMN = 16

export type Colors = { bg: string; fg: string }

const LIGHT: Colors = { bg: '#ffffff', fg: '#27272a' }
const DARK: Colors = { bg: '#1e1e1e', fg: '#e4e4e7' }

function hex(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined
}

// The colours a diagram is drawn in for the theme `/theme` names: a built-in
// one by its name, a custom one (`custom:<name>`) by the base and the
// overrides of its file, whose `inverseText` is the terminal's background.
export function colorsOf(theme: string, custom?: unknown): Colors {
  if (!theme.startsWith('custom:') || typeof custom !== 'object' || custom === null) {
    return theme.includes('light') ? LIGHT : DARK
  }

  const { base, overrides } = custom as { base?: unknown; overrides?: Record<string, unknown> }
  const fallback = typeof base === 'string' && base.includes('light') ? LIGHT : DARK

  return { bg: hex(overrides?.inverseText) ?? fallback.bg, fg: hex(overrides?.text) ?? fallback.fg }
}

// The cells a picture of `width` × `height` pixels takes: no wider than it is
// drawn sharp, nor than `columns`, nor taller than `rows`.
export function pictureBox(
  width: number,
  height: number,
  columns: number,
  rows: number,
): { columns: number; rows: number } {
  let across = Math.max(1, Math.min(columns, Math.round(width / PIXELS_PER_COLUMN)))
  let down = Math.max(1, Math.round((across * height) / width / CELL_ASPECT))
  if (down > rows) {
    down = Math.max(1, rows)
    across = Math.max(1, Math.min(across, Math.round((down * CELL_ASPECT * width) / height)))
  }

  return { columns: Math.min(255, across), rows: Math.min(255, down) }
}

function widest(text: string): number {
  return Math.max(0, ...text.split('\n').map(line => [...line].length))
}

// The text version of a diagram for a pane `columns` wide: as laid out, or
// top-down where that fits and the other doesn't. Trailing blanks dropped.
export function diagramText(diagram: Diagram, columns: number): string | undefined {
  const { text, narrow } = diagram
  if (text === undefined) {
    return undefined
  }

  const chosen = narrow !== undefined && widest(text) > columns && widest(narrow) < widest(text) ? narrow : text

  return chosen
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')
}

// The answer render/mermaid.mjs wrote, for the items it was asked about.
export function parseRendered(stdout: string): Map<string, Diagram> {
  const parsed = JSON.parse(stdout) as { diagrams?: unknown }
  const found = new Map<string, Diagram>()
  for (const raw of Array.isArray(parsed.diagrams) ? parsed.diagrams : []) {
    if (typeof raw !== 'object' || raw === null || typeof (raw as { key?: unknown }).key !== 'string') {
      continue
    }

    const { key, text, narrow, png, width, height, error } = raw as Record<string, unknown>
    found.set(key as string, {
      ...(typeof text === 'string' ? { text } : {}),
      ...(typeof narrow === 'string' ? { narrow } : {}),
      // The path; the hooks module reads the bytes.
      ...(typeof png === 'string' && typeof width === 'number' && typeof height === 'number'
        ? { file: png, width, height }
        : {}),
      ...(typeof error === 'string' ? { error } : {}),
    })
  }

  return found
}
