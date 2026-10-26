# Changelog

All notable changes to claude-mods are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **progress-bars draws tool work as time bars.** In the terminal transcript, each stretch of tool work is one bar whose length shows how long it took, with the time after it. The bar is in the theme's accent colour while it runs, green when it's done, red if something failed and yellow if it was stopped. The turn's footer is a bar too, and a wait on background agents grows until they're back. Their finished notices and hand-back reports are hidden, and ctrl+o still shows everything.
- **prompt-style draws your prompts beside an orange bar.** In the terminal transcript, each prompt you typed sits beside a thin orange bar instead of on a full-width grey band; Claude's replies are unchanged. A slash command's line and a prompt sent with prompt-enhancer's Send keep the band, as Claude Code doesn't let a mod redraw those rows.
- **aside answers side questions about the chat in a pane beside it.** `/aside <question>` opens the pane and answers from the current conversation; follow-ups typed in the pane stay in the same thread. Neither the questions nor the answers enter the main conversation, and New thread starts over. Hand off, or `/aside-handoff [what you want done]`, writes a request from the thread into the prompt box, after any draft there, for you to edit and send.
- **prompt-enhancer rewrites a vague prompt before you send it.** ✨ Enhance above the prompt box, or `/enhance <prompt>`, replaces the draft with a specific version written from the project's instructions, the skills and the chat so far. Send submits it, Undo puts the draft back, and Enter still sends as before.
- **`make install` installs every mod for every session**, from this folder, so `/reload-plugins` picks up an edit.
