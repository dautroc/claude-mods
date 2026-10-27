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

## transcript

- `/transcript` writes the chat as Markdown to `$TMPDIR/claude-transcripts/transcript-<first 8 of the session id>.md`, rewritten each run, then runs `mado action -s $MADO_SESSION edit-file <file> <line>`. Mado opens the session's editor (nvim unless set otherwise) on it in its enlarged float, at the newest prompt's heading. Outside a Mado pane it writes the file and says where. The command is `immediate`, so it runs mid-turn.
- The rows come from `$.session.messages()`: at most the newest 4096, with no timestamps. After a compaction the earlier turns are one summary row: a spike on 2026-10-26 confirmed this on a resumed session. `hooks/markdown.ts` drops the rows the engine writes as user text (command output and its caveat, a skill's body, task notifications, system reminders) by their openings, and this command's own records.

## idea-shelf

- `/idea <text>` saves an idea; `/idea` alone and `/ideas` open the shelf, a pane listing the project's ideas newest first, with a field to add one and Remove on each. Both commands are `immediate`. Like `aside`, an outer `command.run` hook keeps the text and passes `next` empty `args`, so the main model sees `/idea` alone. A save is confirmed by a toast, not command output, which would reach the model.
- The ideas live in `$.store` under `ideas:<root>`, where the root is `$.session.repo().root` (the main working tree's for a worktree, so a repo's worktrees share a shelf), else `$.session.root()`. Each change reads the key again just before writing it, and changes run one at a time, so ideas saved meanwhile by another session or by a second save are kept. `$.state` holds only what the pane draws, read from the store each time the pane opens.
- In `claude plugin test`, the test's own `$` has no `store`, and a hook that throws is skipped rather than failing the call: the tests answer `store.*` themselves, and refuse a write with `{ deny }`.
