// When a tool call ran: `end` is absent while it is still running.
export type CallTime = { start: number; end?: number }

// One background agent run: its id, the tool call that started it, and when
// it began and ended.
export type AgentRun = {
  id: string
  toolUseId: string
  start: number
  end?: number
  outcome?: 'completed' | 'failed' | 'killed'
}

declare module 'claude-code' {
  interface PluginState {
    'progress-bars': {
      calls: StateFamily<Shaped<CallTime | null>>
      agents: Shaped<AgentRun[]>
      turnStarts: Shaped<number[]>
      now: number
    }
  }
}
