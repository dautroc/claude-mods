// Who takes a task: the agent, with its own tools, or the person, for a step
// the agent can't take itself (merging a PR, a deploy it has no access to,
// testing by hand).
export type Owner = 'agent' | 'user'

export type Status = 'todo' | 'in_progress' | 'done'

// One task on a project's board. `id` counts up per project, so the agent and
// the person can both name it (#3). The times are $.clock.now()'s
// milliseconds.
export type Task = {
  id: number
  title: string
  detail?: string
  owner: Owner
  status: Status
  createdAt: number
  updatedAt: number
}

// A project's board as the store keeps it: its tasks in the order they were
// added, and the id the next one takes.
export type Stored = { next: number; tasks: Task[] }

// The board the pane draws: the project it belongs to and its tasks. `root`
// is empty until the first read of the store.
export type Board = { root: string; tasks: Task[] }

declare module 'claude-code' {
  interface PluginState {
    'task-board': { board: Shaped<Board>; draft: string }
  }
}
