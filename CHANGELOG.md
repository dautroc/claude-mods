# Changelog

All notable changes to claude-mods are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **transcript opens this chat in nvim, in a Mado float.** `/transcript` writes the chat as Markdown, a heading for each of your prompts and Claude's replies, each tool call as one line without its output, and opens it at your newest prompt so you can read and search it there. It works mid-turn. Turns from before a compaction show as the summary that replaced them.
- **prompt-style draws your prompts beside an orange bar.** In the terminal transcript, each prompt you typed sits beside a thin orange bar instead of on a full-width grey band; Claude's replies are unchanged. A slash command's line and a prompt sent with prompt-enhancer's Send keep the band, as Claude Code doesn't let a mod redraw those rows.
- **aside answers side questions about the chat in a pane beside it.** `/aside <question>` opens the pane and answers from the current conversation; follow-ups typed in the pane stay in the same thread. Neither the questions nor the answers enter the main conversation, and New thread starts over. Hand off, or `/aside-handoff [what you want done]`, writes a request from the thread into the prompt box, after any draft there, for you to edit and send.
- **prompt-enhancer rewrites a vague prompt before you send it.** ✨ Enhance above the prompt box, or `/enhance <prompt>`, replaces the draft with a specific version written from the project's instructions, the skills and the chat so far. Send submits it, Undo puts the draft back, and Enter still sends as before.
- **`make install` installs every mod for every session**, from this folder, so `/reload-plugins` picks up an edit.
