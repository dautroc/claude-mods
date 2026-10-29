// One prompt the person typed into this chat: the id of its row, which is
// the id the chat draws that row under, its number among the chat's prompts
// from 1, its text as stored, and when it was sent ($.clock.now()'s
// milliseconds) where the row says.
export type Prompt = {
  id: string
  number: number
  text: string
  sentAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-jump': { prompts: Shaped<Prompt[]>; query: string }
  }
}
