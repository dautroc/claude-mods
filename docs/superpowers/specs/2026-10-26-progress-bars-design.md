# progress-bars: tool work drawn as time bars

For whoever builds this mod in `~/tools/claude-mods`. Assumes the repo's `AGENTS.md` and the
plugin-authoring API (`<mod>/.claude-plugin/types/claude-code/index.d.ts` once the mod has loaded).

## Decision

A new mod, `progress-bars`, redraws the transcript rows that record work instead of saying anything:
tool calls, the work line, the waiting line, background agents' notices and the turn footer. Each
stretch of work becomes one bar whose length shows how long it took, followed by the time, in the
theme's colours. Claude's own text is left alone, ctrl+o still shows every row in full, and nothing
the model reads changes. Terminal only.

## Why

The person runs long sessions in which Claude drives subagents through a plan, with an implement,
review, fix and re-review round per task. Every round leaves the same bookkeeping in the transcript:

```
Waiting for Task 4's implementer.

✻ Waiting for 1 background agent to finish · 4 messages hidden (/focus to show)

› Message from @general-purpose (ctrl+o to expand)

  Thought for 7s, read 2 files, ran 1 agent, ran 4 shell commands

Waiting for Task 4's review.
```

Scrolling back to find what happened means wading through these lines, plus raw command text such
as a pasted Python heredoc. They asked for "just a bar and how long it takes" in their place, so
that Claude's sentences are what stands out when they scroll. The same round with the mod on:

```
⏺ Waiting for Task 4's implementer.
  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰ 3m 56s        ← the wait, green once the agent is back
  ▰▰▰▰▰ 7s                              ← the work between, green
⏺ Waiting for Task 4's review.
  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰ 41s                    ← still waiting: accent colour, growing
```

## What each row becomes

| The engine's row | `ui.render` component | Drawn as |
|---|---|---|
| Focus mode's work line: `Thought for 7s, read 2 files, ran 4 shell commands` | `ToolGroup` | One bar for all its calls |
| A folded run outside focus mode: `Read 3 files, ran 2 shell commands` | `ToolGroup` | One bar for all its calls |
| A standalone tool row, `⏺ Bash(…)`, and the result block under it | `ToolUse`, `ToolResult` | One bar; the result block draws nothing |
| `✻ Waiting for 1 background agent to finish · …` | `TurnDuration` | A bar that grows while the agents run, then shows the time waited |
| A background agent's finished notice, and its report, `› Message from @general-purpose` | `UserMessage` | Nothing |
| The turn footer, `✻ Baked for 3m 12s` | `TurnDuration` | A bar of the turn's time |

Every hook passes `next(e)` when `e.props.isExpanded` is true (the ctrl+o transcript, `--verbose`,
a group a hook unfolded), so the full rows are one keypress away. That is what makes hiding rows
acceptable: nothing is lost, only moved behind ctrl+o.

**Rows that stay as the engine draws them**, because the person reads them rather than skims past:

- The rows of `ExitPlanMode` (the plan), `AskUserQuestion` (the questions and answers), and the
  to-do and task-list tools.
- A call the person refused, which carries the feedback they typed.
- Notices about anything other than a background agent: background shell commands, Monitor events,
  workflows, remote agents. Some carry content, and a never-ending command (a dev server, `tail -f`)
  would otherwise keep a wait open forever.
- Messages from people, teammates, other sessions and channels.

### How a bar looks

- The glyph `▰`, indented two cells so bars line up under Claude's text, then one space and the
  time in the engine's own format: `3s`, `1m 4s`, `1h 2m`.
- **No label.** The person compared four mockups and chose bar plus time over a variant with a few
  words of what the step did, a fixed-width bar that fills, and a time column.
- **Length grows with time on a log scale**, so slow steps stand out when scrolling: a one-second
  step is a short stub and a ten-minute step reaches the bar's maximum width. A running bar grows
  live.
- **Colours are theme keys** (`ThemeKey` in the API), so they follow whichever theme is set:

| State | Theme key | Default themes |
|---|---|---|
| Running, or still waiting | `claude` | Claude orange |
| Finished | `success` | green |
| Any call in it failed, or an agent it waited on failed | `error` | red |
| Ended by Esc or `$.turn.abort`, or an agent it waited on was killed | `warning` | yellow |

The person chose `success` for finished bars after seeing eight theme colours drawn in their own
terminal. Their first pick was the theme's dim grey, but in use the grey bars looked uncoloured.

## Goals

- Every row in the table above draws as described in the main transcript on the terminal, in and out
  of focus mode.
- A running step's bar grows while it runs and changes to its finished colour when it ends.
- Tool-work bars in a resumed session, or for steps made before the mod loaded, show real times.
  Footers there show the turn's time (see "Waiting" below).

## Non-goals

- Rewriting Claude's own text. The person's first message asked for plain wording, but once shown
  both, they narrowed it to bars only.
- Labels on bars, or one bar per call inside a group.
- The live spinner (`Spinner`), the prompt hint, and every surface other than the terminal (desktop,
  VS Code, mobile draw their own rows and keep them).
- Leaving out of a bar the time a call spent waiting at a permission prompt. A bar measures wall-clock
  time, and the person mostly runs in auto mode, where there is no prompt.

## Anti-goals

- **A failure that looks like success.** A group with any errored call is red, never green.
- **A made-up time.** A row whose duration the mod can't establish keeps the engine's own drawing.
  A wrong time is worse than a cluttered row.
- **A slower interface.** Redrawing runs only while something is running or being waited on, and
  stops when everything is idle.
- **Information lost.** ctrl+o shows everything, and the stored conversation is never touched.

## Constraints

- The repo's layout and workflow in `AGENTS.md`: the mod's folder with `.claude-plugin/plugin.json`,
  `hooks/hooks.json` naming `hooks/register.tsx`, its `$.state` contract in `types/index.d.ts`, and
  tests in `tests/`. It is listed in `.claude-plugin/marketplace.json`, and `make test` and
  `make install` pass. A section goes in `AGENTS.md` and an entry under Unreleased in `CHANGELOG.md`.
- `$` may be passed only to functions declared at the top level of the hooks module.
- Writes to `$.state` are refused while a `ui.render` hook draws. Record from `tool.call`, timers and
  other events, and only read while drawing.
- `prompt-style` already hooks `UserMessage` for the person's own prompts. This mod must pass those
  rows through untouched, and both mods must keep working when both are installed.

## What the spike established

A throwaway mod, loaded into the design session on 2026-10-26 and since deleted, logged every row the
terminal asked plugins to draw and timed every tool call. It found:

- **In focus mode, all the work of one turn is a single `ToolGroup` row**, with a `requestId` of
  `brief-collapsed-<uuid>` and every call of the turn in `calls`, each with its `tool_use_id`. A turn
  with no tool calls still has a group, with `calls: []`. No `ToolUse` row is drawn in focus mode.
- **`isCallsOnly` is false on a group in which a call errored.** The group is still drawn as a bar,
  in red.
- **A `tool.call` hook sees every call start and end.** It wraps `next(e)`; a `sleep 6` measured
  6.87 s.
- **Drawing a tree in place of the group works.** The person saw the spike's bars in their
  transcript and asked only about their colour. Whether a bar visibly grew while a call ran was not
  checked.
- **`TurnDuration` carries no `waitingFor` in focus mode**, even when a background agent was still
  running as the turn ended: the row had only `word`, `durationMs` and `isExpanded`. The API says
  `waitingFor` is present only while the line draws nothing but its waiting text, and in focus mode
  it also carries the hidden-messages count. The mod therefore keeps its own record of pending
  background work.
- **A background agent's notice is a `UserMessage` with `origin.kind` `task-notification`.** Its
  `task` carried `id`, `status`, `toolUseId` (the launching call) and `durationMs`.
- **`› Message from @general-purpose` is the agent's hand-back report.** It is a `UserMessage` with
  `origin.kind` `peer` and `from.name` the agent's type. `peer` also covers messages from genuinely
  other sessions, so the mod has to confirm the sender is one of this session's own agents (for
  example against `$.agent.list()`). The stored entry's origin also has `handback: true` and `from` set to
  the agent's id, but the API's `PromptOrigin` does not expose those two fields.
- **The session file records times.** Each assistant entry holding a `tool_use` and each user entry
  holding its `tool_result` has an ISO `timestamp`, so a call's duration can be recovered after a
  resume. Session files reach 10 MB and more.
- **A footer row's `requestId` is the `uuid` of the session file's `system` entry with `subtype`
  `turn_duration`.** That entry's `timestamp` is when the turn ended. This held for all four footers
  the spike logged, so a footer can be tied to its turn.

## How it works (decided)

**Timing.** A `tool.call` hook on every tool records the start and end of each call by
`tool_use_id`, plus whether it failed or was interrupted, in `$.state`, so a reload keeps it and a
write redraws the rows that read it. It is a gating hook, so give it a `.catch` that passes the call
through: a fault in the mod must never block a tool.

**History.** For a call the mod never saw (the session was resumed, or the call ran before the mod
loaded), take its start and end from the session file's timestamps: the `tool_use` entry's time and
the `tool_result` entry's time. If neither source has it, the row keeps the engine's drawing.

**A group's time** is wall-clock time from its first call's start to its last call's end, or to now
while a call runs. It is not the sum, because calls in a group often run in parallel.

**Waiting.** Only background agents count as pending work. The engine's own waiting line also counts
workflows, but their notices carry content and stay visible, so a workflow's footer keeps the turn's
time. When a background agent is launched, the mod records it. When its notice row arrives
(`task-notification`, matched on `task.id` or `task.toolUseId`), the mod records the end and its
`status`. When a turn ends (`turn.complete`), the mod records the end time and the agents still out,
which later lets its footer be found by `requestId`.

A footer whose turn ended with agents still out is a waiting bar. It is measured from the turn's end
until the earlier of the last of those agents finishing or the next turn starting. Its finished
colour comes from the agents that ended within the wait: red if any failed, yellow if any was
killed, green otherwise. An agent still running when the wait ends doesn't count; the next footer
picks it up, because it is still out when that turn ends.

Any other footer shows the turn's `durationMs`. So does every footer of a resumed session, unless the
mod still holds that wait in `$.state`. That keeps the history reader to tool-call times alone.

**Live growth.** While any call is running or any wait is open, a timer redraws about twice a second
(`$.ui.invalidate('ui.render')`, or a `$.state` write the bars read). The timer stops when nothing is
open, so an idle session does no work.

## Calls made without the person, to check

1. A group's bar measures the span of its calls, so thinking before the first call is not counted.
   The turn footer covers the whole turn.
2. A work line with no tool calls in it (thinking only) is hidden, because the footer already shows
   the turn's time.
3. Only background agents count as something to wait on. Their finished notices and hand-back reports
   go away; notices about shell commands, Monitor events, workflows and remote agents stay.
4. The bar's maximum width is 40 cells, or narrower when the terminal has less room after the time.
   About ten minutes reaches it.
5. A wait ends at whichever comes first: the agents finishing, or the next turn starting. Its colour
   comes from the agents that ended within it.
6. A group is drawn as a bar even when it holds rows other than calls (recalled memory, hook timing).
   Those rows stay behind ctrl+o.
7. The plan, questions-and-answers, to-do and task-list rows, and refused calls stay as the engine
   draws them.
8. After a resume, footers show the turn's time, not the wait.
9. Time spent at a permission prompt counts in the bar.

## Left to the builder

- The exact scale formula, provided it is monotonic, gives a one-second step a short stub and reaches
  full width at about ten minutes. The spike's `round(log2(1 + ms / 250) * 3)` gives about 7 cells for
  1 s, 16 for 10 s, 24 for 1 m and 34 for 10 m.
- How to show a step under a second.
- How to read a session file larger than `$.fs.read`'s 4 MiB limit: the tail only, `$.process.run`
  with a line filter, or something else. Also when to read it (once at `session.start`, or on demand).
- The shape of the `$.state` contract, and its `shape` tag for values stored by an earlier version.
- Tests: at least one per row in the table, plus the failed, interrupted, expanded and no-known-time
  cases.
