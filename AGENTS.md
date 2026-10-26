# Working on claude-mods

- Each top-level folder is one Claude Code mod, a plugin of function hooks: `.claude-plugin/plugin.json`, `hooks/hooks.json` naming `hooks/register.tsx`, its state contract in `types/index.d.ts`, tests in `tests/`. The plugin-authoring skill holds the API and its types.
- `.claude-plugin/marketplace.json` lists every mod. `make install` adds this folder as the `claude-mods` marketplace and installs each listed mod at user scope, so every session loads it. Installing writes `enabledPlugins` and the marketplace into `~/.claude/settings.json`, which is a link into `~/dotfiles`.
- An installed mod is read from this folder, not from a copy: after an edit, `/reload-plugins` in a running session loads it. No reinstall, no version bump.
- To add a mod: write it with the plugin-authoring skill, where it hot-reloads in that session, then move its folder here without `.claude-plugin/types/`, add it to `marketplace.json`, and run `make test` and `make install`.
- `make test` runs `claude plugin validate` on the marketplace and each mod, then each mod's `claude plugin test`.
- The engine lays the API's types in `<mod>/.claude-plugin/types/` (ignored) only when it loads the mod from a folder it hot-reloads. The mod's `tsconfig.json` extends them, so `tsc -p <mod>` works only after such a load.
- `$` may be passed only to functions declared at the top level of the hooks module: `claude plugin validate` refuses a helper defined inside `register`.
- The main model reads a mod's slash command as a record: `<command-name>/x</command-name>` with its arguments. To keep the arguments out, an outer `command.run` hook keeps them and passes `next` empty `args`; the hook beneath answers from what it kept (see `aside`).
- Running `claude -p` from an agent's shell to try a mod needs `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT` and `CLAUDE_CODE_*` unset; `--plugin-dir <copy>` loads it. There is no prompt box under `-p`, so `$.prompt.fill` answers `isFilled: false`.

## prompt-enhancer

- ✨ Enhance in the band above the prompt box, or `/enhance <prompt>`, rewrites the draft in place; Send submits the box, Undo puts the draft back. Enter is untouched.
- The rewrite is a `$.model.fork` over the session, so it reads the system prompt, instruction files, skills and the whole chat. Before the session's first turn there is nothing to fork: it reads the CLAUDE.md and AGENTS.md files from the project root up, plus the non-built-in commands, and calls `$.model.complete` on the session's model.
- The rewrite rules live in `hooks/enhance.ts`. A prompt sent with Send goes through `$.prompt.submit`, which does not expand `@file` mentions, so the rules ask for plain paths.

## aside

- `/aside [question]` opens the Aside pane, docked beside the transcript in fullscreen, and asks there; the pane's field takes follow-ups in the same thread. `/btw` is a built-in, so the command can't take that name.
- Each question is a `$.model.fork` over the main conversation, with the side thread's earlier exchanges in the prompt, so nothing is added to the main conversation. The main model sees only `/aside` with empty arguments. A spike on 2026-10-26 confirmed both.
- Questions run on a `$.clock.after` timer, so the command and the field return at once. The thread lives in `$.state` for the session; `/clear` empties it.
- Hand off and `/aside-handoff` fork the same way with the answered exchanges and write a request in the person's voice; `$.prompt.fill` puts it in the box (appended after a draft), never submitted. No call moves the keys from a pane to the prompt box: the person presses Esc.

## prompt-style

- On the terminal, a `UserMessage` row from `composer` (typed here, and still so on resume) or `bridge` (Remote Control) is drawn beside a one-column `claude` bar with no background, in place of the engine's full-width `userMessageBackground` band. Every other row, and every other surface, goes to `next`.
- The engine raises no `UserMessage` for a slash command's echo (`❯ /reload-plugins`) or for a prompt a plugin submits, `asUser` or not (prompt-enhancer's Send), so those keep the band. A spike on 2026-10-26 confirmed both.

## progress-bars

- It redraws the terminal rows `ToolGroup`, `ToolUse`, `ToolResult`, `TurnDuration` and `UserMessage`. Each hook passes `next(e)` when `isExpanded` is true, so ctrl+o shows the full rows. `KEEP_TOOLS` (`ExitPlanMode`, `AskUserQuestion`, the to-do and task tools, `SendUserMessage`) and a refused call keep the engine's drawing only as standalone rows; inside a group they are part of the bar. Every other `UserMessage` returns `next` before any read, so prompt-style's rows are untouched.
- Times come from a `tool.call` hook into the `calls` family of `$.state`, keyed by `tool_use_id`. For anything the mod never saw, `hooks/history.ts` keeps one index per session (calls' times and names, `turn_duration` entries, hand-back uuids), read from the session file, found by `find` under `CLAUDE_CONFIG_DIR` or `~/.claude`. Session files reach well over 100 MB, so the index is one regex pass with `-o`, never a grep per needle: `rg`, else `grep`, over the whole file once, then `tail -c +<offset> | grep` from the last uuid/timestamp match. A scan runs at most once a second (`REFRESH_MS`), one at a time; a lookup that finds what it wants in the index runs none. `session.start` warms the first scan. A running row with no start in state keeps the engine's drawing and looks nothing up.
- `ticker.ts` writes `now` every 500 ms while a call is open or a background agent has no `end`, then stops. An agent with no `end` counts as open for six hours, and a tick settles one the engine no longer lists, or lists as completed, failed or killed (`$.agent.list()`).
- A background agent is recorded when an `Agent` call returns `async_launched`, and ended by the `turn.complete` carrying its `agentId`. A footer's `requestId` is the `uuid` of the session file's `system` entry with `subtype` `turn_duration`; its `pendingBackgroundAgentCount` above zero makes the footer a wait (`waitFor`). `TurnDuration.waitingFor` is absent in focus mode, so the mod keeps its own record of the agents. With no agent recorded a footer shows `durationMs` and reads nothing. A footer drawn before its line is written shows `durationMs`, and the ticker's writes draw it again. After a resume, footers show `durationMs`.
- A `task-notification` is hidden when its launching call was `Agent`: matched in state by `id` or `toolUseId`, else by the session file's tool name. A notice with `task.type` set (a remote agent, an artifact watch) is never hidden. A `peer` row is hidden when its saved entry has `origin.handback: true`; `PromptOrigin` doesn't expose that field, so the session file is read. `› Message from @<agent>` is that row. Spikes on 2026-10-26 confirmed the footer `requestId`, the `waitingFor` absence and the hand-back `peer` row. That a `peer` row's `requestId` is its saved entry's `uuid` is an assumption, not yet confirmed live.
