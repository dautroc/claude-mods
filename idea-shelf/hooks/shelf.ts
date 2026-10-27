// A project's ideas as the store keeps them, and how the pane names them.

import type { Idea } from '../types'

// One store key per project, by its root.
export function keyOf(root: string): string {
  return `ideas:${root}`
}

// The ideas a store value holds, newest first. Anything else in it is passed
// over rather than failing the shelf.
export function parseIdeas(value: unknown): Idea[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isIdea)
}

function isIdea(value: unknown): value is Idea {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const { id, text, savedAt } = value as Record<string, unknown>

  return typeof id === 'string' && typeof text === 'string' && text !== '' && typeof savedAt === 'number'
}

// The project's folder name, for the pane's title and the toasts.
export function nameOf(root: string): string {
  return root.split('/').filter(part => part !== '').at(-1) ?? root
}

// The day an idea was saved, as YYYY-MM-DD in local time.
export function dayOf(savedAt: number): string {
  const day = new Date(savedAt)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}
