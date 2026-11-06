// One question of the side thread and what came back for it: an answer or
// an error, neither while the answer is on its way. A note from You should
// know is an entry too: its card's line as the question, its explanation as
// the answer.
export type Entry = {
  id: string
  question: string
  answer?: string
  error?: string
  isNote?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    aside: { thread: Shaped<Entry[]>; draft: string; handing: boolean }
  }
}
