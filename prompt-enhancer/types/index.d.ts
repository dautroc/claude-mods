// Where the enhancer stands with the draft in the prompt box.
export type Phase =
  | { kind: 'idle' }
  | { kind: 'enhancing'; id: string; original: string }
  | { kind: 'enhanced'; original: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-enhancer': { phase: Shaped<Phase>; hasDraft: boolean }
  }
}
