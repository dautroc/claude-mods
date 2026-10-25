# Changelog

All notable changes to claude-mods are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **prompt-enhancer rewrites a vague prompt before you send it.** ✨ Enhance above the prompt box, or `/enhance <prompt>`, replaces the draft with a specific version written from the project's instructions, the skills and the chat so far. Send submits it, Undo puts the draft back, and Enter still sends as before.
- **`make install` installs every mod for every session**, from this folder, so `/reload-plugins` picks up an edit.
