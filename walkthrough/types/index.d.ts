// One way to answer an item. `recommended` marks the one Claude recommends.
export type Choice = { label: string; detail?: string; recommended?: true }

// What the pane shows beside an item: a Mermaid diagram, Markdown (tables
// included), code in `language`, or a unified diff.
export type PreviewKind = 'mermaid' | 'markdown' | 'code' | 'diff'
export type Preview = { kind: PreviewKind; source: string; language?: string }

// One item to review. No choices means the answer is the person's own words.
export type Item = {
  title: string
  body?: string
  recommendation?: string
  choices: Choice[]
  multiSelect?: true
  preview?: Preview
}

// The person's answer to one item: the choices picked, by index, and a note,
// which is the answer itself where nothing is picked.
export type Answer = { picked: number[]; note: string }

// The review in the pane: its items and answers, the item shown, which is
// `items.length` for the summary, and the tool call that opened it.
export type Review = { id: string; call?: string; title: string; items: Item[]; answers: Answer[]; at: number }

// An item's Mermaid diagram as drawn: box-drawing text (`narrow` laid out
// top-down, for a left-right flowchart), a PNG as base64 with its file and
// size in pixels, or why it couldn't be drawn.
export type Diagram = {
  text?: string
  narrow?: string
  png?: string
  file?: string
  width?: number
  height?: number
  error?: string
}

// The diagrams of review `review`, by item index.
export type Diagrams = { review: string; byItem: Record<string, Diagram> }

// How a diagram is shown: the picture, the text version, or its source.
export type Shown = 'picture' | 'text' | 'source'

declare module 'claude-code' {
  interface PluginState {
    walkthrough: { review: Shaped<Review | null>; diagrams: Shaped<Diagrams>; shown: Shown }
  }
}
