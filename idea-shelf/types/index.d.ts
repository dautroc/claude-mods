// One idea on a project's shelf, saved at `savedAt` ($.clock.now()'s
// milliseconds).
export type Idea = {
  id: string
  text: string
  savedAt: number
}

// The shelf the pane draws: the project it belongs to and its ideas, newest
// first. `root` is empty until the first read of the store.
export type Shelf = { root: string; ideas: Idea[] }

declare module 'claude-code' {
  interface PluginState {
    'idea-shelf': { shelf: Shaped<Shelf>; draft: string }
  }
}
