# Changelog

All notable changes to claude-mods are recorded here. Each mod is versioned and released on its own, so each has its own section and its own tags (`aside-v0.1.0`); the last section covers the repository itself (`v0.1.0`). A change not yet released goes under an Unreleased heading at the top of its section. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## prompt-enhancer

### [0.1.0] - 2026-10-29

#### Added

- **prompt-enhancer rewrites a vague prompt before you send it.** ✨ Enhance above the prompt box, or `/enhance <prompt>`, replaces the draft with a specific version written from the project's instructions, the skills and the chat so far. Send submits it, Undo puts the draft back, and Enter still sends as before.

## aside

### [0.1.0] - 2026-10-29

#### Added

- **aside answers side questions about the chat in a pane beside it.** `/aside <question>` opens the pane and answers from the current conversation; follow-ups typed in the pane stay in the same thread. Neither the questions nor the answers enter the main conversation, and New thread starts over. Hand off, or `/aside-handoff [what you want done]`, writes a request from the thread into the prompt box, after any draft there, for you to edit and send.

## prompt-style

### [0.1.0] - 2026-10-29

#### Added

- **prompt-style draws your prompts beside an orange bar.** In the terminal transcript, each prompt you typed sits beside a thin orange bar instead of on a full-width grey band; Claude's replies are unchanged. A slash command's line and a prompt sent with prompt-enhancer's Send keep the band, as Claude Code doesn't let a mod redraw those rows.

## transcript

### [0.1.0] - 2026-10-29

#### Added

- **transcript opens this chat in nvim, in a Mado float.** `/transcript` writes the chat as Markdown, a heading for each of your prompts and Claude's replies, each tool call as one line without its output, and opens it at your newest prompt so you can read and search it there. It works mid-turn. Turns from before a compaction show as the summary that replaced them.

## idea-shelf

### [0.1.0] - 2026-10-29

#### Added

- **idea-shelf keeps the ideas that come up while you code, for each project.** `/idea <text>` saves one without the agent seeing it, and works mid-turn. `/ideas` opens the shelf, a pane listing this project's ideas newest first, where you can type a new one or remove one. Every worktree of a repository shares its shelf, and the ideas stay between sessions.

## task-board

### [0.1.0] - 2026-10-29

#### Added

- **task-board keeps a task list for each project that the agent updates as it works.** While it plans, the agent adds each step to the board, marks a step in progress when it starts and done when it finishes. A step it can't take itself, such as merging a PR, running a deploy or testing by hand, goes on the board as yours, and a toast tells you. `/board` opens the board in a pane, grouped into in progress, to do and done, where you can start, finish, reopen or remove a task, clear the done ones, or add one of your own. Every worktree of a repository shares the board, and it stays between sessions.

## paste-thumbnails

### [0.1.0] - 2026-10-29

#### Added

- **paste-thumbnails shows the images you paste above the prompt box.** Each image pasted into the box appears as a small thumbnail in the band above it, labelled with the number of its `[Image #N]` tag, and goes once the tag leaves the box. It needs a terminal Claude Code draws images in: kitty, Ghostty and iTerm2 3.5 or later as they are, Mado once `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` is set. Elsewhere each thumbnail shows the image's size instead.

## reply-style

### [0.1.0] - 2026-10-29

#### Added

- **`ctrl+x y` puts a letter on each code block and draft on screen; type one to copy it.** As with flash.nvim's labels, the block nearest the prompt gets `a`, the next ones up `s`, `d`, `f` and on along the keyboard. The letter you type is copied and kept out of the prompt box, and a draft there stays as it was. Any other key takes the letters down and types as usual, as does `ctrl+x y` again. The key runs `/flash-copy`, bound in `~/.claude/keybindings.json`, and works in the fullscreen layout.
- **reply-style puts a copy button on what Claude drafts for you to paste elsewhere.** A Slack message, an email, a PR comment, a commit message or a ticket's description comes in a block of its own under a label such as "Slack reply to Hana", with a `[ copy ]` button that copies exactly the text shown; `/reply-style copy draft` copies the last one in the last reply. Claude is told to write drafts this way in every session that shows its replies, but not under `claude -p`, where a script reads the reply. Where reply-style doesn't draw, such as in the desktop app, the block shows as an ordinary code block.
- **reply-style draws Claude's replies in your theme's colours.** In the terminal, headings, lists, task lists, quotes and GitHub alerts (`> [!TIP]`) get their own colours and marks, tables are boxed with aligned columns that fit the window (Japanese text included), and numbers, paths, inline code and links are coloured. Each code block shows its language and a `[ copy ]` button. Slash-command output written as markdown is drawn the same way. `/reply-style copy` copies the last reply and `/reply-style copy code` its last code block, mid-turn too. The desktop, VS Code and mobile apps keep their own drawing.

## walkthrough

### [0.1.0] - 2026-10-29

#### Added

- **walkthrough steps you through what Claude needs you to decide, one item at a time.** When Claude has several questions or decisions for you, it opens a pane beside the chat with one item at a time: what it is, Claude's recommendation and the choices, with a diagram, table, code or diff beside it where that helps. `j` and `k` move between the choices, Space ticks one (several where the item takes several), Enter picks and moves on, and `h` and `l` go to the previous and next item. `w` types your own answer or a note, which Enter saves and Esc clears, and `s` shows all your answers and sends them to Claude as your next message. Keys typed in the pane stay there and never land in the prompt box. Mermaid diagrams show as pictures in terminals that draw images (kitty, Ghostty, iTerm2, or Mado with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1`) and as box-drawing text elsewhere; `t` switches between them. `/walk` opens the pane again. It needs `node`, and `rsvg-convert` for the pictures. Sonnet used it unprompted in testing; Haiku wrote the list in its reply instead.

## restart

### [0.1.0] - 2026-10-29

#### Added

- **restart makes `/restart` bring this session back in a fresh Claude Code.** It ends Claude Code and starts it again in the same terminal pane, from a login shell that reads your shell's startup files again, and resumes the same session with the flags you started it with. Changed settings, new exports in `~/.zshrc` and a newly installed Claude Code version all take effect, and it works with Remote Control on, where the built-in `/restart` refuses. It needs Claude Code to have been started from a shell such as zsh or bash; otherwise the built-in `/restart` runs. In Mado it types the command through Mado, elsewhere straight into the terminal.

## Repository

### [0.1.0] - 2026-10-29

#### Added

- **`make install` installs every mod for every session**, from this folder, so `/reload-plugins` picks up an edit.
