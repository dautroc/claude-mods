import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Thumb } from '../types'
import { fit, imageIds, label, pngSize, sipsSize, tempRoot } from './thumbs'

type Engine = EngineInterface

// Change the tag when Thumb's fields change: it declines what an earlier
// version stored, which outlives a reload.
const thumbs = atom({ plugin: 'paste-thumbnails', key: 'thumbs' } as const, [] as Thumb[], {
  shape: 'thumbs-1',
})

const SIPS = '/usr/bin/sips'
// The longest side of a thumbnail in pixels: sharp at five rows on a Retina
// screen, and small to send to the terminal.
const MAX_SIDE = 320
// The rows a thumbnail takes: five where the band has room, never under two.
const MAX_ROWS = 5
const MIN_ROWS = 2
// A paste puts its tag in the box a moment before the image file is written.
const ATTEMPTS = 5
const RETRY_MS = 200

let uid: string | undefined
// The images folder of the session it was found for.
let folder: { sessionId: string; path: string } | undefined
// Thumbnails made since the module loaded, by source file, size and time, so
// a tag that comes back costs no sips run.
const made = new Map<string, Thumb>()
// The tags the latest refresh is for, and its number: a later one wins.
let tracked: string | undefined
let generation = 0

async function imageFolder($: Engine): Promise<string | undefined> {
  const sessionId = await $.session.id()
  if (folder?.sessionId === sessionId) {
    return folder.path
  }

  uid ??= (await $.process.run(['/usr/bin/id', '-u'])).stdout.trim()
  const root = tempRoot(await $.env.get('CLAUDE_CODE_TMPDIR'), uid)
  // The project part of the path is the folder the session started in, which
  // the API doesn't give, so look for the session under each project.
  for (const entry of await $.fs.list(root).catch(() => [])) {
    const path = `${root}/${entry.name}/${sessionId}/images`
    if (entry.kind === 'dir' && (await $.fs.exists(path))) {
      folder = { sessionId, path }

      return path
    }
  }

  return undefined
}

// The thumbnail of image `id`, or undefined while Claude Code has not saved
// it (or it is no picture sips can read).
async function thumbnail($: Engine, images: string, id: number): Promise<Thumb | undefined> {
  const entry = (await $.fs.list(images)).find(file => file.kind === 'file' && file.name.startsWith(`${id}.`))
  if (entry === undefined) {
    return undefined
  }

  const source = `${images}/${entry.name}`
  const key = `${source}:${entry.size}:${entry.mtimeMs}`
  const known = made.get(key)
  if (known !== undefined) {
    return known
  }

  const pasted = sipsSize((await $.process.run([SIPS, '-g', 'pixelWidth', '-g', 'pixelHeight', source])).stdout)
  if (pasted === undefined) {
    return undefined
  }

  // `Image` takes PNG only. sips enlarges a small picture to -Z's size too, so
  // a small PNG is sent as it is.
  let file = source
  const isLarge = Math.max(pasted.width, pasted.height) > MAX_SIDE
  if (isLarge || !entry.name.endsWith('.png')) {
    const out = `${images.replace(/\/images$/, '')}/paste-thumbnails/${id}.png`
    await $.process.run(['/bin/mkdir', '-p', out.slice(0, out.lastIndexOf('/'))])
    const resize = isLarge ? ['-Z', String(MAX_SIDE)] : []
    const { exitCode } = await $.process.run([SIPS, ...resize, '-s', 'format', 'png', source, '--out', out])
    if (exitCode !== 0) {
      return undefined
    }

    file = out
  }

  const { base64 } = await $.fs.read(file, { as: 'bytes' })
  const size = pngSize(base64)
  if (size === undefined) {
    return undefined
  }

  const thumb = { id, png: base64, size, pasted }
  made.set(key, thumb)

  return thumb
}

async function load($: Engine, ids: readonly number[]): Promise<Thumb[]> {
  const images = await imageFolder($).catch(() => undefined)
  if (images === undefined) {
    return []
  }

  const found: Thumb[] = []
  for (const id of ids) {
    const thumb = await thumbnail($, images, id).catch(() => undefined)
    if (thumb !== undefined) {
      found.push(thumb)
    }
  }

  return found
}

// Makes the thumbnails of the tags in the box, again while a file is not
// written yet, and shows them unless the tags changed meanwhile.
async function refresh($: Engine, ids: readonly number[], run: number) {
  let found: Thumb[] = []
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    found = await load($, ids)
    if (run !== generation || found.length === ids.length || attempt === ATTEMPTS) {
      break
    }

    await $.clock.sleep(RETRY_MS)
  }

  if (run === generation) {
    await update($, thumbs, () => found)
  }
}

// Called with the box after every change; a keystroke that leaves the tags
// as they were costs nothing.
async function track($: Engine, text: string) {
  const ids = imageIds(text)
  const key = ids.join(',')
  if (key === tracked) {
    return
  }

  tracked = key
  const run = ++generation
  if (ids.length === 0) {
    await update($, thumbs, () => [])

    return
  }

  // On a timer, so the paste or key that changed the box doesn't wait on sips.
  $.clock.after(1, () => void refresh($, ids, run))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A reload forgets what was tracked: start from the box as it stands.
    tracked = undefined
    await track($, (await $.prompt.read()).text)

    return started
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await track($, box.text)

    return box
  })

  // A pasted image lands here, its tag put in the box by the engine; so does
  // a submit or a clear that empties the box.
  on('prompt.change', async ($, e, next) => {
    const changed = await next(e)
    await track($, e.text)

    return changed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey || e.props.view.agentId !== undefined) {
      return next(e)
    }

    const shown = await read($, thumbs)
    // One row under the thumbnails for their labels, one for what is beneath.
    const rows = Math.min(MAX_ROWS, e.props.maxRows - 2)
    if (shown.length === 0 || rows < MIN_ROWS) {
      return next(e)
    }

    const beneath = await next(e)
    const { Box, Image, Text } = $.ui.resolve(e)
    const { placed, hidden } = fit(shown, rows, e.props.bodyColumns)

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          {placed.map(({ thumb, columns }) => (
            <Box flexDirection="column">
              <Image
                key={`image-${thumb.id}`}
                source={{ png: thumb.png }}
                columns={columns}
                rows={rows}
                alt={`${thumb.pasted.width}×${thumb.pasted.height}`}
              />
              <Text dimColor>{label(thumb.id)}</Text>
            </Box>
          ))}
          {hidden > 0 ? <Text dimColor>+{hidden} more</Text> : null}
        </Box>
        {beneath}
      </Box>
    )
  })
}
