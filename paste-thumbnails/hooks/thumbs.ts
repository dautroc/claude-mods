import type { Size } from '../types'

// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2
// The widest a thumbnail is drawn, in columns.
const MAX_COLUMNS = 40
// Room for "+99 more" and the gap before it.
const MORE_COLUMNS = 9

// The numbers of the `[Image #N]` tags in a draft, each once, in the order
// they first appear.
export function imageIds(text: string): number[] {
  return [...new Set([...text.matchAll(/\[Image #(\d+)\]/g)].map(match => Number(match[1])))]
}

// Where Claude Code keeps the session temp folders of this user. Each image
// pasted into the prompt box is saved the moment it lands, as
// `<this>/<project>/<session id>/images/<N>.<png|jpg|gif|webp>`, <project>
// being the folder the session started in with every character outside
// [a-zA-Z0-9] turned into "-". Not part of the plugin API: read from Claude
// Code 2.1.311, so a later version may move it.
export function tempRoot(tmpdir: string | undefined, uid: string): string {
  return `${(tmpdir || '/tmp').replace(/\/+$/, '')}/claude-${uid}`
}

// The pixel size `sips -g pixelWidth -g pixelHeight` printed.
export function sipsSize(stdout: string): Size | undefined {
  const width = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1])
  const height = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1])

  return width > 0 && height > 0 ? { width, height } : undefined
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// The bytes of whole base64 quads, undefined at a character outside them.
function decode(base64: string): number[] | undefined {
  const bytes: number[] = []
  for (let at = 0; at + 4 <= base64.length; at += 4) {
    const sextets = [...base64.slice(at, at + 4)].map(char => BASE64.indexOf(char))
    if (sextets.some(sextet => sextet < 0)) {
      return undefined
    }

    const [a = 0, b = 0, c = 0, d = 0] = sextets
    const word = (a << 18) | (b << 12) | (c << 6) | d
    bytes.push((word >> 16) & 0xff, (word >> 8) & 0xff, word & 0xff)
  }

  return bytes
}

// The pixel size a PNG's header gives, or undefined for bytes that are no PNG:
// the signature, then the IHDR chunk with the width and height at 16 and 20.
export function pngSize(base64: string): Size | undefined {
  const head = decode(base64.slice(0, 32))
  const isPng = head?.length === 24 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  if (head === undefined || !isPng) {
    return undefined
  }

  const word = (at: number) => head.slice(at, at + 4).reduce((value, byte) => value * 256 + byte, 0)
  const size = { width: word(16), height: word(20) }

  return size.width > 0 && size.height > 0 ? size : undefined
}

// How many columns a picture takes drawn `rows` rows tall.
export function columnsFor(size: Size, rows: number): number {
  const columns = Math.round((rows * CELL_ASPECT * size.width) / size.height)

  return Math.min(MAX_COLUMNS, Math.max(2, columns))
}

// The label under a thumbnail.
export function label(id: number): string {
  return `#${id}`
}

// A thumbnail and the columns its picture takes.
type Placed<T> = { thumb: T; columns: number }

// The thumbnails that fit side by side in `columns`, one column apart, each
// as wide as its picture or its label; when some don't fit, room is left for
// a "+n more" after the ones that do.
export function fit<T extends { id: number; size: Size }>(
  thumbs: readonly T[],
  rows: number,
  columns: number,
): { placed: Placed<T>[]; hidden: number } {
  const place = (room: number) => {
    const placed: Placed<T>[] = []
    let used = 0
    for (const thumb of thumbs) {
      const picture = columnsFor(thumb.size, rows)
      const width = Math.max(picture, label(thumb.id).length)
      const gap = placed.length === 0 ? 0 : 1
      if (used + gap + width > room) {
        break
      }

      placed.push({ thumb, columns: picture })
      used += gap + width
    }

    return placed
  }

  const all = place(columns)
  if (all.length === thumbs.length) {
    return { placed: all, hidden: 0 }
  }

  const some = place(columns - MORE_COLUMNS)

  return { placed: some, hidden: thumbs.length - some.length }
}
