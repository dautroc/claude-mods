import type { On } from 'claude-code'
import type { Mounted } from 'claude-code/testing'

// What the engine draws for a row when the plugin passes.
export function engine(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

// A bar's drawing: the run of ▰ (its count and colour), then the time.
export async function readBar(ui: Mounted) {
  const [glyphs, time] = await ui.findAll({ type: 'Text' })
  if (!glyphs || !time) {
    throw new Error('no bar drawn: expected a run of glyphs and a time')
  }

  return { glyphs: glyphs.text.length, color: glyphs.props.color, time: time.text.trim() }
}
