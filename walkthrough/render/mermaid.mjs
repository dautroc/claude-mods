// Renders Mermaid diagrams for the walkthrough pane, run by the hooks module
// with `node render/mermaid.mjs` (a hooks module can't run this library
// itself). Reads one JSON request on stdin and writes one JSON answer:
//
//   in:  { out, colors: { bg, fg }, diagrams: [{ key, source }] }
//   out: { diagrams: [{ key, text?, narrow?, png?, width?, height?, error? }] }
//
// `text` is the diagram in box-drawing characters; `narrow` the same diagram
// laid out top-down, for a left-right flowchart too wide for the pane. `png`
// is the path of a picture of it, `width` × `height` pixels, missing where
// rsvg-convert is not installed.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderMermaidASCII, renderMermaidSVG } from './vendor/beautiful-mermaid.mjs'

// Twice the SVG's size, sharp on a Retina screen; never wider than this.
const ZOOM = 2
const MAX_WIDTH = 2400
const FONT = 'Helvetica Neue'
const TEXT = { colorMode: 'none', paddingX: 3, paddingY: 1, boxBorderPadding: 0 }
const LEFT_RIGHT = /^(\s*(?:flowchart|graph)\s+)(LR|RL)\b/

function read() {
  return new Promise((resolve, reject) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => (text += chunk))
    process.stdin.on('end', () => resolve(text))
    process.stdin.on('error', reject)
  })
}

// `#rrggbb` as its three channels.
function channels(hex) {
  return [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16))
}

// `pct` percent of `fg` over `bg`, as CSS's color-mix in sRGB.
function mix(fg, bg, pct) {
  const [a, b] = [channels(fg), channels(bg)]

  return `#${a.map((v, i) => Math.round((v * pct + b[i] * (100 - pct)) / 100).toString(16).padStart(2, '0')).join('')}`
}

// The SVG with its CSS variables resolved, for rsvg-convert, which draws
// every `var()` black. The mixes are the library's own (its <style> block).
function flatten(svg, { bg, fg }) {
  const values = {
    '--bg': bg,
    '--fg': fg,
    '--_text': fg,
    '--_text-sec': mix(fg, bg, 60),
    '--_text-muted': mix(fg, bg, 40),
    '--_text-faint': mix(fg, bg, 25),
    '--_line': mix(fg, bg, 50),
    '--_arrow': mix(fg, bg, 85),
    '--_node-fill': mix(fg, bg, 3),
    '--_node-stroke': mix(fg, bg, 20),
    '--_group-fill': bg,
    '--_group-hdr': mix(fg, bg, 5),
    '--_inner-stroke': mix(fg, bg, 12),
    '--_key-badge': mix(fg, bg, 10),
  }

  // rsvg-convert skips the font the <style> block names, so it is set on the
  // root too, where every text inherits it.
  return svg
    .replace('<svg ', `<svg font-family="${FONT}, Helvetica, Arial, sans-serif" `)
    .replace(/@import[^;]*;/g, '')
    .replace(/var\((--[\w-]+)(?:,[^()]*(?:\([^()]*\))?[^()]*)?\)/g, (whole, name) => values[name] ?? whole)
}

function sizeOf(svg) {
  const width = Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1])
  const height = Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(svg)?.[1])

  return width > 0 && height > 0 ? { width, height } : undefined
}

function picture(source, key, out, colors) {
  const svg = flatten(renderMermaidSVG(source, { ...colors, font: FONT, transparent: true }), colors)
  const size = sizeOf(svg)
  if (size === undefined) {
    return {}
  }

  const width = Math.min(MAX_WIDTH, Math.round(size.width * ZOOM))
  const height = Math.round((size.height * width) / size.width)
  const svgPath = join(out, `${key}.svg`)
  const png = join(out, `${key}.png`)
  writeFileSync(svgPath, svg)
  try {
    execFileSync('rsvg-convert', ['-w', String(width), '-h', String(height), '-b', colors.bg, '-o', png, svgPath], {
      stdio: 'ignore',
      timeout: 20_000,
    })
  } catch {
    return {}
  }

  return { png, width, height }
}

function render({ key, source }, out, colors) {
  let text
  try {
    text = renderMermaidASCII(source, TEXT)
  } catch (error) {
    return { key, error: String(error?.message ?? error).split('\n')[0] }
  }

  const diagram = { key, text }
  if (LEFT_RIGHT.test(source)) {
    try {
      diagram.narrow = renderMermaidASCII(source.replace(LEFT_RIGHT, '$1TD'), TEXT)
    } catch {
      // The left-right text stands alone.
    }
  }

  try {
    Object.assign(diagram, picture(source, key, out, colors))
  } catch {
    // The text stands alone.
  }

  return diagram
}

const request = JSON.parse(await read())
mkdirSync(request.out, { recursive: true })
const diagrams = request.diagrams.map(diagram => render(diagram, request.out, request.colors))
process.stdout.write(JSON.stringify({ diagrams }))
