import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { fit, imageIds, pngSize, sipsSize } from '../hooks/thumbs'

const BAND = {
  plugin: 'paste-thumbnails',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// A 64×40 PNG, solid blue.
const BLUE =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAAV0lEQVR4nO3PUQkAIBTAwJfEzDbWEH4cwmABbrP2+brhgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAseu0qlwvFxtV31AAAAAElFTkSuQmCC'

const SESSION = '3dd7ff78'
const ROOT = '/tmp/claude-502'
const IMAGES = `${ROOT}/-work/${SESSION}/images`
const THUMBS = `${ROOT}/-work/${SESSION}/paste-thumbnails`

type File = { base64: string; width: number; height: number }

// Stands for the engine: Claude Code's temp folders as `disk` holds them,
// `id` and `sips` (which writes its PNG into `disk`), and every command run.
function engine(on: On, disk: Map<string, File>) {
  const runs: string[][] = []
  const box = { text: '' }
  mock.env(on, {})
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  // What the engine draws in the band when the plugin passes.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('fs.list', (_, e) => {
    if (e.path === ROOT) {
      return { value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    }

    const files = [...disk.keys()].filter(path => path.startsWith(`${e.path}/`))

    return {
      value: files.map(path => ({ name: path.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 1, isLink: false })),
    }
  })
  on('fs.exists', (_, e) => ({ value: [...disk.keys()].some(path => path.startsWith(`${e.path}/`)) }))
  on('fs.read', (_, e) => {
    const file = disk.get(e.path)

    return file === undefined ? { deny: `${e.path}: ENOENT` } : { value: { base64: file.base64 } }
  })
  const ran = (exitCode: number, stdout: string) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    if (argv[0] === '/usr/bin/id') {
      return ran(0, '502\n')
    }

    if (argv[0] === '/usr/bin/sips' && argv[1] === '-g') {
      const file = disk.get(argv.at(-1) ?? '')

      return file === undefined ? ran(1, '') : ran(0, `  pixelWidth: ${file.width}\n  pixelHeight: ${file.height}\n`)
    }

    if (argv[0] === '/usr/bin/sips') {
      disk.set(argv.at(-1) ?? '', { base64: BLUE, width: 64, height: 40 })
    }

    return ran(0, '')
  })

  return { runs, box }
}

// The plugin reads the box when the session starts, as after a reload; a
// test can't raise the editor's own prompt.change or prompt.edit.
async function start($: Engine, box: { text: string }, text: string) {
  box.text = text
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

describe('the helpers', () => {
  test('find each tag once, in order', () => {
    expect(imageIds('[Image #2] and [Image #1], again [Image #2]; [Image #x]')).toEqual([2, 1])
  })

  test('read a PNG size, and refuse bytes that are no PNG', () => {
    expect(pngSize(BLUE)).toEqual({ width: 64, height: 40 })
    expect(pngSize('aGVsbG8gd29ybGQsIHRoaXMgaXMgbm8gUE5HIGF0IGFsbA==')).toBeUndefined()
    expect(sipsSize('/x.jpg\n  pixelWidth: 1280\n  pixelHeight: 800\n')).toEqual({ width: 1280, height: 800 })
  })

  test('fit what the band holds and count the rest', () => {
    const wide = { size: { width: 400, height: 100 } }
    const thumbs = [1, 2, 3].map(id => ({ id, ...wide }))
    // 5 rows of a 4:1 picture take 40 columns.
    expect(fit(thumbs, 5, 100)).toMatchObject({ placed: [{ columns: 40 }, { columns: 40 }], hidden: 1 })
    expect(fit(thumbs, 5, 130).hidden).toBe(0)
  })
})

describe('the band', () => {
  test('shows a pasted image as a thumbnail labelled with its tag, above what is beneath', async ($, on) => {
    const disk = new Map([[`${IMAGES}/1.png`, { base64: BLUE, width: 64, height: 40 }]])
    const { runs, box } = engine(on, disk)
    const clock = mock.clock(on)
    await start($, box, '[Image #1] ')
    await clock.advance(1)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const image = await ui.find({ type: 'Image' })
    expect(image?.props).toMatchObject({ source: { png: BLUE }, rows: 5, alt: '64×40' })
    expect((await ui.find({ type: 'Text', text: '#1' }))?.text).toBe('#1')
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    // A small PNG goes as it is: sips only measured it.
    expect(runs.filter(argv => argv[0] === '/usr/bin/sips')).toEqual([
      ['/usr/bin/sips', '-g', 'pixelWidth', '-g', 'pixelHeight', `${IMAGES}/1.png`],
    ])
    await ui.unmount()
  })

  test('shrinks a large or non-PNG image to a PNG with sips', async ($, on) => {
    const disk = new Map([[`${IMAGES}/2.jpg`, { base64: '', width: 1280, height: 800 }]])
    const { runs, box } = engine(on, disk)
    const clock = mock.clock(on)
    await start($, box, 'look at [Image #2]')
    await clock.advance(1)

    expect(runs).toContainEqual([
      '/usr/bin/sips',
      '-Z',
      '320',
      '-s',
      'format',
      'png',
      `${IMAGES}/2.jpg`,
      '--out',
      `${THUMBS}/2.png`,
    ])
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { png: BLUE }, alt: '1280×800' })
    await ui.unmount()
  })

  test('waits for the file Claude Code writes just after the tag', async ($, on) => {
    const disk = new Map<string, File>()
    const { box } = engine(on, disk)
    const clock = mock.clock(on)
    await start($, box, '[Image #1]')
    await clock.advance(1)
    disk.set(`${IMAGES}/1.png`, { base64: BLUE, width: 64, height: 40 })
    await clock.advance(200)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { png: BLUE } })
    await ui.unmount()
  })

  test('empties once the tags leave the box', async ($, on) => {
    const disk = new Map([[`${IMAGES}/1.png`, { base64: BLUE, width: 64, height: 40 }]])
    const { box } = engine(on, disk)
    const clock = mock.clock(on)
    await start($, box, '[Image #1] ')
    await clock.advance(1)
    // Sent: the box is emptied.
    await start($, box, '')

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('leaves a tag with no image behind it out', async ($, on) => {
    const { box } = engine(on, new Map())
    const clock = mock.clock(on)
    await start($, box, 'typed [Image #7] by hand')
    await clock.advance(1000)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    await ui.unmount()
  })

  test('draws nothing of its own on the desktop, which has no Image', async ($, on) => {
    const disk = new Map([[`${IMAGES}/1.png`, { base64: BLUE, width: 64, height: 40 }]])
    const { box } = engine(on, disk)
    const clock = mock.clock(on)
    await start($, box, '[Image #1] ')
    await clock.advance(1)

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })
})
