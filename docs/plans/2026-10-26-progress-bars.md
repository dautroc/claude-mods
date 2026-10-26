# progress-bars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A claude-mods mod that draws the transcript's tool-work, waiting, notice and turn-footer
rows as one bar per stretch of work, its length showing how long it took, followed by the time.

**Architecture:** A `tool.call` hook times every main-loop call into `$.state`. `ui.render` hooks on
`ToolUse`, `ToolResult`, `ToolGroup`, `TurnDuration` and `UserMessage` draw bars from those times, or
hide the row. When the mod never saw a call, the hooks fall back to the session file's timestamps,
read with `grep -F` through `$.process.run`. A ticker writes a `now` value twice a second while
anything is running or being waited on, so running bars grow.

**Tech Stack:** Claude Code plugin hooks module (TypeScript + JSX against the `claude-code` API), `claude plugin test`, `claude plugin validate`, `tsc`.

**Spec:** `docs/superpowers/specs/2026-10-26-progress-bars-design.md`. Read it before any task.

## Global Constraints

- The mod is the folder `progress-bars/` in `~/tools/claude-mods`, laid out as `AGENTS.md` describes.
  Its manifest name is `progress-bars`, at version `0.1.0`.
- Draw on `e.surface === 'terminal'` only. Every other surface returns `next(e)`.
- Every render hook returns `next(e)` when `e.props.isExpanded === true`.
- Colours are theme keys only: running `claude`, finished `success`, failed `error`, stopped `warning`.
- Glyph `▰`. The bar is indented two cells, then one space and the time.
- Never write `$.state` inside a `ui.render` hook. Write from `tool.call`, `turn.start`,
  `turn.complete` and the ticker.
- `$` is passed only to functions declared at the top level of a module (`claude plugin validate`
  refuses others).
- A fault in the mod never blocks a tool: the `tool.call` hook carries `.catch(($, e, next) => next(e))`.
- A row whose duration the mod can't establish keeps the engine's drawing. Never guess a time.
- Use `await $.clock.now()` for time, never `Date.now()`, so `mock.clock` drives the tests.
- Calls and turns with `e.agentId` set belong to a subagent. Record none of them, with one
  exception: Task 5 needs the `turn.complete` that ends a background agent.

## Review Focus

1. **Hot reload while a call runs.** The old module's wrapper may never record the end. Expected:
   once the row says `isRunning: false`, the bar uses the session file's time or the engine's row,
   and never keeps growing. Tested in Task 4.
2. **Session file missing, or `grep`/`find` failing** (another `CLAUDE_CONFIG_DIR`, exit code 2, a
   throw). Expected: the engine's row, with no error line in the transcript. Tested in Task 4.
3. **`grep` output over 4 MiB** (`isStdoutTruncated`, last line cut). Expected: the whole lines are
   used and the cut one is skipped. Tested in Task 4.
4. **A narrow terminal** (`viewport.columns` 30). Expected: the bar shrinks so bar and time fit on
   one line. Tested in Task 2.
5. **prompt-style installed alongside.** Expected: a `composer` `UserMessage` passes through this mod
   untouched. Tested in Task 6.

## File Structure

```
progress-bars/
  .claude-plugin/plugin.json   manifest, names types/index.d.ts
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/register.tsx           every on(...) hook; thin, delegates to the files below
  hooks/scale.ts               barCells, formatDuration (pure)
  hooks/bar.tsx                drawBar, drawNothing, tone helpers
  hooks/state.ts               atoms: callTime(id), agents, turnStarts, now
  hooks/history.ts             session-file lookups (grep), parseEntries, callTimesFrom (pure parts)
  hooks/waits.ts               waitFor (pure)
  hooks/ticker.ts              ensureTicking, tick
  types/index.d.ts             $.state contract
  tsconfig.json                { "extends": "./.claude-plugin/types/tsconfig.json" }
  tests/helpers.tsx            engine(on), readBar(ui), shared props builders
  tests/scale.test.ts
  tests/tool-rows.test.tsx
  tests/groups.test.tsx
  tests/history.test.tsx
  tests/waits.test.tsx
  tests/notices.test.tsx
```

Test conventions, mirroring `prompt-style/tests/prompt-style.test.tsx` and `aside/tests/aside.test.tsx`:
an `engine(on)` helper whose `ui.render` hook draws `<Text>engine</Text>`, so that "kept the engine's
drawing" asserts `ui.find({ type: 'Text', text: 'engine' })`. Mount with `$.ui.mount({ plugin:
'progress-bars', surface, component, requestId, props })`. Use `mock.clock(on, { now: 1_800_000_000_000 })`.
Answer `$` calls beneath the plugin with `on('<noun>.<method>', () => ({ value }))`, as aside's tests
do. Module-level caches may outlive a test, so give each test its own tool_use_ids and session id.

`tests/helpers.tsx` (created in Task 2) holds `engine(on)` and `readBar(ui)`. `readBar` returns
`{ glyphs: number, color: string, time: string }` from the drawn tree: the first `Text` is the `▰`
run (its count and `color`), and the second holds the time (trimmed).

---

### Task 1: Scaffold, scale, state, and timing every call

**Files:**
- Create: `progress-bars/.claude-plugin/plugin.json`, `progress-bars/hooks/hooks.json`, `progress-bars/tsconfig.json`, `progress-bars/types/index.d.ts`, `progress-bars/hooks/scale.ts`, `progress-bars/hooks/state.ts`, `progress-bars/hooks/register.tsx`
- Modify: `.claude-plugin/marketplace.json` (add the entry)
- Test: `progress-bars/tests/scale.test.ts`, `progress-bars/tests/tool-rows.test.tsx` (timing part)

**Interfaces:**
- Produces, in `types/index.d.ts`:
  `export type CallTime = { start: number; end?: number }`;
  `export type AgentRun = { id: string; toolUseId: string; start: number; end?: number; outcome?: 'completed' | 'failed' | 'killed' }`.
  It declares under `PluginState['progress-bars']`: `calls` (a `StateFamily` of `CallTime | null`, shaped),
  `agents` (`AgentRun[]`, shaped), `turnStarts` (`number[]`, shaped), and `now` (`number`). Use whatever
  `StateFamily`/`Shaped` spelling makes `tsc -p progress-bars` pass; aside's contract shows `Shaped`.
- Produces, in `hooks/state.ts`: `SHAPE = 'progress-bars-1'`;
  `callTime(id: string)` returns the atom `{ plugin: 'progress-bars', key: 'calls', id }`, initial
  `null`, `{ shape: SHAPE }`; atoms `agents` (initial `[]`), `turnStarts` (initial `[]`) and `now`
  (initial `0`).
- Produces, in `hooks/scale.ts`: `MAX_CELLS = 40`;
  `barCells(ms: number, maxCells = MAX_CELLS): number`;
  `formatDuration(ms: number): string`.

- [ ] **Step 1: Write the failing scale tests** (`tests/scale.test.ts`)

```ts
test('barCells grows on a log scale and reaches 40 at ten minutes', () => {
  expect([0, 200, 1_000, 10_000, 60_000, 600_000, 3_600_000].map(ms => barCells(ms)))
    .toEqual([1, 1, 4, 15, 26, 40, 40])
  expect(barCells(600_000, 20)).toBe(20)
  expect(barCells(1_000, 0)).toBe(1)
})
test('formatDuration matches the engine', () => {
  expect([999, 1_000, 59_999, 64_000, 3_720_000].map(formatDuration))
    .toEqual(['<1s', '1s', '59s', '1m 4s', '1h 2m'])
})
```

- [ ] **Step 2: Run them and see them fail.** Run `claude plugin test progress-bars`. Expected:
  FAIL, because the module isn't found.

- [ ] **Step 3: Implement `scale.ts`.**
  `barCells` = `max(1, min(maxCells, round(maxCells * ln(1 + ms/1000) / ln(601))))`, and `1` when
  `maxCells < 1`. `formatDuration` floors to whole seconds: under 1 s it is `<1s`, under a minute
  `Ns`, under an hour `Nm Ns`, otherwise `Nh Nm`.

- [ ] **Step 4: Write the failing timing test** (`tests/tool-rows.test.tsx`, `describe('timing')`)
  - `records start and end of a main-loop call`: start `mock.clock`. The test's own `tool.call`
    hook captures `e.tool_use_id`, waits `clock.sleep(14_000)` and answers a Bash result. Call
    `$.tool.call({ tool: 'Bash', command: 'make test' })`, then `clock.advance(14_000)`, then await
    the call. Expect `(await $.state.get({ plugin: 'progress-bars', key: 'calls', id })).value` to
    equal `{ start: T0, end: T0 + 14_000 }`.
  - `ignores a subagent's call`: the same, with `agentId: 'a1'`. Expect the value `null`, or absent.
  - `a fault in the mod never blocks the call`: make the state write throw, for instance with a
    `state.set` hook of the test's that denies. Expect `$.tool.call` still to resolve with the
    tool's result.

- [ ] **Step 5: Implement the `tool.call` hook in `register.tsx`.** Skip when `e.agentId` is set.
  Otherwise write `{ start }`, `await next(e)`, write `{ start, end }` in a `finally`, and return
  the result. Attach `.catch(($, e, next) => next(e))`. Write `plugin.json` (with `"types":
  "./types/index.d.ts"`), `hooks.json` and `tsconfig.json`, and add the marketplace entry:
  `{ "name": "progress-bars", "source": "./progress-bars", "description": "Draws tool work, waits and turn footers in the transcript as bars whose length shows how long they took" }`.
  Use the same text as the manifest's description.

- [ ] **Step 6: Run the checks.** Run `claude plugin test progress-bars`,
  `claude plugin validate progress-bars` and `tsc -p progress-bars`. If `.claude-plugin/types/` is
  missing, follow the plugin-authoring skill's note on type-checking before the first load.
  Expected: all pass.

- [ ] **Step 7: Commit.** `git add progress-bars .claude-plugin/marketplace.json`, then
  `git commit -m "feat(progress-bars): time every tool call"`.

### Task 2: Standalone tool rows as bars

**Files:**
- Create: `progress-bars/hooks/bar.tsx`, `progress-bars/tests/helpers.tsx`
- Modify: `progress-bars/hooks/register.tsx`
- Test: `progress-bars/tests/tool-rows.test.tsx`

**Interfaces:**
- Consumes: `callTime`, `now` from `state.ts`; `barCells`, `formatDuration`, `MAX_CELLS` from `scale.ts`.
- Produces, in `bar.tsx`: `type BarTone = 'running' | 'done' | 'failed' | 'stopped'`;
  `TONE_COLOR: Record<BarTone, ThemeKey>` = `{ running: 'claude', done: 'success', failed: 'error', stopped: 'warning' }`;
  `toneOf(row: { isRunning: boolean; isErrored: boolean; isInterrupted: boolean }): BarTone`, which
  checks running, then interrupted, then errored;
  `drawBar($, e, ms: number, tone: BarTone)`, a `<Box paddingLeft={2}>` holding a `Text` of
  `'▰'.repeat(cells)` in `TONE_COLOR[tone]` and a `<Text dimColor>` of `' ' + formatDuration(ms)`.
  `cells = barCells(ms, min(MAX_CELLS, (e.viewport?.columns ?? 80) - 4 - label.length))`.
  Also `drawNothing($, e)`, which returns `<Box />`.
- Produces, in `register.tsx`: `KEEP_TOOLS = new Set(['ExitPlanMode', 'AskUserQuestion', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'SendUserMessage'])`,
  `REFUSED_PREFIX = "The user doesn't want to proceed with this tool use"`, and
  `toolUseMs($, id, isRunning): Promise<number | undefined>`. It reads `callTime(id)` (which
  subscribes). For a running call it also reads `now` and measures up to `await $.clock.now()`. It
  returns `undefined` when there is no start, or when the call has stopped and has no end; Task 4
  adds the session-file fallback here.

- [ ] **Step 1: Write the failing tests.** Each times a call as in Task 1, then mounts `ToolUse`
  with its id:
  - `a finished call is a green bar with its time`: a 14 s call gives `readBar` →
    `{ glyphs: barCells(14_000), color: 'success', time: '14s' }`.
  - `a running call is an accent bar that grows`: start a call, `clock.advance(5_000)`, mount
    with `isRunning: true`. Expect `color: 'claude'` and time `5s`. Then `clock.advance(55_000)`
    and `ui.redraw()`; expect time `1m 0s` and glyphs `barCells(60_000)`.
  - `a failed call is red`: `isErrored: true`. `an interrupted call is yellow`: `isInterrupted:
    true, isErrored: true`.
  - `the result block under a bar draws nothing`: mount `ToolResult` for the same id and expect no
    `Text`.
  - `kept as the engine draws them`, one test each:
    - `isExpanded: true`;
    - a `desktop` surface;
    - every tool in `KEEP_TOOLS`;
    - an errored call whose `output` starts with `REFUSED_PREFIX`;
    - an id with no recorded time.

    Each asserts `engine` on `ToolUse`, and on `ToolResult` too.
  - `a narrow terminal shrinks the bar`: `viewport: { columns: 30 }` on a 10-minute call. Expect
    `glyphs + 2 + 1 + time.length <= 30`.

- [ ] **Step 2: Run them and see them fail.** `claude plugin test progress-bars`; expected: the new
  tests fail.
- [ ] **Step 3: Implement `bar.tsx`, `toolUseMs`, and the `ToolUse` and `ToolResult` render hooks.**
  `ToolResult` draws nothing exactly when its `ToolUse` would draw a bar. Make the decision one shared
  function, `barFor($, e, row)`, which returns `{ ms, tone } | undefined`, so the two can't drift.
- [ ] **Step 4: Run the tests, `validate` and `tsc`.** Expected: all pass.
- [ ] **Step 5: Commit** `feat(progress-bars): draw a tool row as a bar of its time`.

### Task 3: Groups, including focus mode's work line

**Files:**
- Modify: `progress-bars/hooks/register.tsx`
- Test: `progress-bars/tests/groups.test.tsx`

**Interfaces:**
- Consumes: `toolUseMs`'s readers (`callTime`, `now`), `drawBar`, `drawNothing`, `toneOf`.
- Produces: `groupSpan($, calls): Promise<{ ms: number; isRunning: boolean } | undefined>`. The
  span runs from the earliest start to the latest end, or to now while any call runs. It is
  `undefined` if any call lacks a `tool_use_id`, or lacks a start, or has stopped and lacks an end.

- [ ] **Step 1: Write the failing tests.** Mount `ToolGroup`, with
  `requestId: 'brief-collapsed-<uuid>'` for the focus-mode cases:
  - `two parallel calls show the span, not the sum`: call A runs 0–10 s and B runs 2–6 s, giving
    time `10s`.
  - `a group with an errored call is red once all have ended`, and `accent while one still runs`,
    even when another has already errored.
  - `an interrupted call makes it yellow`.
  - `a group with no calls draws nothing` (`calls: []`).
  - `kept as the engine draws them`: `isExpanded: true`, a `desktop` surface, and a call with no
    recorded time.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the `ToolGroup` render hook.** The tone is `running` if any call
  `isRunning`, else `stopped` if any `isInterrupted`, else `failed` if any `isErrored`, else `done`.
  Draw regardless of `isCallsOnly`.
- [ ] **Step 4: Run the tests, `validate` and `tsc`.**
- [ ] **Step 5: Commit** `feat(progress-bars): draw a run of calls as one bar`.

### Task 4: Live growth, and times from the session file

**Files:**
- Create: `progress-bars/hooks/ticker.ts`, `progress-bars/hooks/history.ts`
- Modify: `progress-bars/hooks/register.tsx` (start the ticker; fall back to history in
  `toolUseMs` and `groupSpan`)
- Test: `progress-bars/tests/history.test.tsx`, and add a ticker case to `tool-rows.test.tsx`

**Interfaces:**
- Produces, in `ticker.ts`: `ensureTicking($): void`, which starts one `$.clock.every(500, () => tick($))`
  if none runs, and `tick($): Promise<void>`. `tick` writes `now` to `await $.clock.now()` while
  anything is open, and otherwise cancels the timer. Open means a call started in this module and
  not yet ended (a module-level `Set<string>` the `tool.call` hook keeps), or an `agents` entry with
  no `end` whose `start` is within the last 6 hours. Call `ensureTicking` from the `tool.call` hook
  when a call starts. Call it from `session.start` too, which covers agents still out after a reload.
- Produces, in `history.ts`:
  - `type SessionEntry = { type?: string; subtype?: string; uuid?: string; timestamp?: string; pendingBackgroundAgentCount?: number; origin?: { kind?: string; handback?: boolean }; message?: { content?: unknown } }`.
  - `parseEntries(stdout: string): SessionEntry[]` parses one JSON object per line. It skips a line
    that doesn't parse, which covers a cut last line.
  - `callTimesFrom(entries: SessionEntry[]): Map<string, CallTime>`. Every `tool_use` block of a
    `type: 'assistant'` entry gives `start = Date.parse(timestamp)`; every `tool_result` block of a
    `type: 'user'` entry gives `end`.
  - `toolNameFrom(entries: SessionEntry[], id: string): string | undefined`.
  - `sessionFile($): Promise<string | null>`. It takes the base directory from
    `$.env.get('CLAUDE_CONFIG_DIR')`, or `${HOME}/.claude` without it. Then it runs
    `$.process.run(['find', `${base}/projects`, '-maxdepth', '2', '-name', `${await $.session.id()}.jsonl`])`
    and takes the first line. It caches only a found path.
  - `lookup($, needles: string[]): Promise<SessionEntry[]>` runs
    `$.process.run(['grep', '-F', ...needles.flatMap(n => ['-e', n]), file])`. Exit code 1 gives `[]`.
    Any other non-zero exit, a throw, or no file also gives `[]`.
  - `historyTimes($, ids: string[]): Promise<Map<string, CallTime>>` uses the needles
    `"id":"<id>"` and `"tool_use_id":"<id>"`. It caches each id once both its times are found.
  - `entryByUuid($, uuid: string): Promise<SessionEntry | undefined>` uses the needle
    `"uuid":"<uuid>"`, keeps the entry whose `uuid === uuid`, and caches a hit only.

- [ ] **Step 1: Write the failing tests.** The pure ones need no engine:
  - `parseEntries skips a cut last line`: two whole lines plus `'{"type":"us'` give 2 entries.
  - `callTimesFrom reads starts and ends`. Build the entry lines with the real key order seen in
    the session file: `"uuid":"…","timestamp":"…"` follow `"message"`. A tool_use at
    `2026-10-26T10:42:28.252Z` with its result at `…30.554Z` gives a 2302 ms call.

  The engine ones answer `session.id`, `env.get` (via `mock.env`) and `process.run` beneath the
  plugin:
  - `a resumed session's call shows its saved time`: no `tool.call` was seen. `process.run` answers
    `find` with a path, and `grep` with the two lines. Expect a `ToolUse` bar with time `2s`.
  - `the ToolUse row stops growing after a reload lost its end`: the state has `{ start }` and no
    end, the row has `isRunning: false`, and history has both times. Expect history's time. With no
    history, expect `engine`.
  - `no session file, or grep failing, keeps the engine's row`: `find` prints nothing; then `grep`
    exits 2; then `process.run` throws. Each expects `engine`, and the test sees no error.
  - `a running bar grows by the ticker alone`: start a call and mount it running, then advance
    1 500 ms without calling `ui.redraw()`. Expect the drawn time to have changed. After the call
    ends and a further `advance(1_000)`, expect no more `now` writes; spy with a `state.set` hook of
    the test's that passes through.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement `history.ts` and `ticker.ts`, and wire them in.** In `toolUseMs` and
  `groupSpan`, call `historyTimes` once for the ids the state lacks before giving up.
- [ ] **Step 4: Run the tests, `validate` and `tsc`.**
- [ ] **Step 5: Commit** `feat(progress-bars): grow running bars, read old calls' times from the session file`.

### Task 5: Background agents and the turn footer

**Files:**
- Create: `progress-bars/hooks/waits.ts`
- Modify: `progress-bars/hooks/register.tsx`
- Test: `progress-bars/tests/waits.test.tsx`

**Interfaces:**
- Consumes: `agents`, `turnStarts`, `now` atoms; `entryByUuid`; `drawBar`; `ensureTicking`.
- Produces, in `waits.ts`: `type Wait = { ms: number; tone: BarTone }` and
  `waitFor(turnEnd: number, runs: readonly AgentRun[], starts: readonly number[], at: number): Wait | null`.
  This is the spec's "Waiting" rule:
  - The agents out are those with `start < turnEnd` and either no `end` or `end > turnEnd`. With
    none out, the result is `null`.
  - The wait ends at the earlier of two things: the first start strictly after `turnEnd`, and the
    latest end, once every agent out has one.
  - With neither, the wait is still open: `{ ms: at - turnEnd, tone: 'running' }`.
  - Otherwise the tone comes from the agents out whose `end` is at or before the wait's end:
    `failed` if any has outcome `failed`, else `stopped` if any has `killed`, else `done`.
- Produces, in `register.tsx`:
  - The `tool.call` hook appends `{ id: result.agentId, toolUseId: e.tool_use_id, start: end }` to
    `agents` when `e.tool === 'Agent'` and `result.status === 'async_launched'`, then calls
    `ensureTicking`.
  - A `turn.start` hook appends `await $.clock.now()` to `turnStarts` for the main loop only,
    keeping the last 200.
  - A `turn.complete` hook acts when `e.agentId` matches an `agents` entry. It sets that entry's
    `end` to now, and its `outcome`: `killed` if `e.isAborted`, `failed` if `e.reason` is `error`
    or `refusal`, else `completed`.
  - A `TurnDuration` render hook. It reads `agents` and `turnStarts`, which subscribes it, so an
    agent ending or a turn starting redraws it. Then it calls `entryByUuid(e.requestId)`.
    - If the entry has `pendingBackgroundAgentCount > 0`, it calls
      `waitFor(Date.parse(entry.timestamp), …)`. A non-null result draws as a wait bar; while that
      bar's tone is `running`, the hook also reads `now`.
    - Every other case draws `drawBar($, e, e.props.durationMs, 'done')`: no entry yet, no pending
      count, or `waitFor` returning `null`, as after a resume.

- [ ] **Step 1: Write the failing tests.** Pure `waitFor` cases, with `T = 100_000`:
  - one agent out, still running at `T + 30_000`: `{ ms: 30_000, tone: 'running' }`;
  - it ends at `T + 40_000` with the next turn starting at `T + 40_050`: `{ ms: 40_000, tone: 'done' }`;
  - two agents out, with the next turn starting when the first ends: the wait stops there, and the
    second, still running, doesn't colour it;
  - an agent that failed is `failed`, and one killed is `stopped`;
  - an agent launched after `T`, or ended before `T`, doesn't count: `null`.

  Engine cases, mounting `TurnDuration` with `requestId: 'u1'`, where `grep` answers a
  `turn_duration` line for `u1`:
  - `a footer whose turn left an agent out grows, then shows the wait`. The `Agent` call answers
    `async_launched` with `agentId: 'ag1'`, and the line has `pendingBackgroundAgentCount: 1`. While
    the agent runs, the bar is accent. After `$.turn.complete({ agentId: 'ag1', … })` and a
    `$.turn.start(…)`, it is green with the time waited.
  - `a plain footer shows the turn's time`: green, time from `durationMs`.
  - `a resumed footer shows the turn's time`: the line has a pending count but `agents` is empty.
  - `kept as the engine draws it`: `isExpanded: true`, and a `desktop` surface.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests, `validate` and `tsc`.**
- [ ] **Step 5: Commit** `feat(progress-bars): draw the turn footer as a bar, and a wait on agents as one that grows`.

### Task 6: Hide background agents' notices and hand-back reports

**Files:**
- Modify: `progress-bars/hooks/register.tsx`
- Test: `progress-bars/tests/notices.test.tsx`

**Interfaces:**
- Consumes: `agents`, `entryByUuid`, `lookup`, `toolNameFrom`, `drawNothing`.
- Produces: a `UserMessage` render hook. It reads `agents` and `turnStarts` (to subscribe), then:
  - **`origin.kind === 'task-notification'`:** draws nothing when `agents` has an entry with
    `toolUseId === e.props.task?.toolUseId` or `id === e.props.task?.id`. Otherwise it looks up
    `"id":"<task.toolUseId>"` and draws nothing when `toolNameFrom` gives `Agent`.
  - **`origin.kind === 'peer'`:** draws nothing when `entryByUuid(e.requestId)` has
    `origin.handback === true`.
  - Every other row returns `next(e)`.

- [ ] **Step 1: Write the failing tests.**
  - `an agent's finished notice is hidden`: one case matched by state, one by the session file.
  - `an agent's hand-back report is hidden`: a `peer` row whose saved entry has `handback: true`.
  - `kept as the engine draws them`:
    - a background shell's notice (the launching call is `Bash`);
    - a `peer` row with no `handback`, which is another session;
    - `composer`, `bridge`, `channel` and `plugin` rows (Review Focus 5);
    - `isExpanded: true`;
    - a `desktop` surface.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests, `validate` and `tsc`.**
- [ ] **Step 5: Commit** `feat(progress-bars): hide background agents' notices and reports`.

### Task 7: Docs, live check, install

**Files:**
- Modify: `AGENTS.md` (a `## progress-bars` section), `CHANGELOG.md` (an entry under Unreleased → Added)
- Test: the whole repo (`make test`)

- [ ] **Step 1: Write the `AGENTS.md` section** in the style of the existing ones, as facts a future
  editor needs:
  - which rows it redraws, and that `isExpanded` passes everything through;
  - that times come from `tool.call` into `$.state`, with the session file read by `grep` as the
    fallback;
  - that a footer's `requestId` is the `uuid` of the session file's `turn_duration` entry, which
    carries `pendingBackgroundAgentCount`;
  - that `TurnDuration.waitingFor` is absent in focus mode;
  - that `› Message from @<agent>` is a `peer` row whose saved origin has `handback: true`.

  Spikes on 2026-10-26 confirmed the last three.
- [ ] **Step 2: Write the CHANGELOG entry**, one bolded sentence and then plain detail, as the
  others are.
- [ ] **Step 3: Run `make test`.** Expected: every mod validates and passes.
- [ ] **Step 4: Check it live.** Copy `progress-bars/` without `.claude-plugin/types/` to
  `~/.claude/dev-mods/<this session's id>/progress-bars/`. In the next turn, run a 6-second
  `sleep`, and launch one background `haiku` agent that runs `sleep 20` in the foreground. Then end
  the turn and confirm the transcript has no `progress-bars:` hook-failure line. Ask the person
  whether the bars look right. Then delete the dev-mods copy.
- [ ] **Step 5: Commit and install.** `git add AGENTS.md CHANGELOG.md`, then
  `git commit -m "docs(progress-bars): agent notes and changelog"`, then `make install`. Tell the
  person to run `/reload-plugins`.
