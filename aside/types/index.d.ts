// One question of the side thread and what came back for it: an answer or
// an error, neither while the answer is on its way.
export type Entry = {
  id: string
  question: string
  answer?: string
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    aside: { thread: Shaped<Entry[]>; draft: string }
  }
}
