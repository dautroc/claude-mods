// /flash-copy's letters, by reply row's requestId: the letter each copy
// button of the row shows, by its number; '' for one without.
export type Hints = Record<string, string[]>

declare module 'claude-code' {
  interface PluginState {
    'reply-style': { hints: Shaped<Hints> }
  }
}
