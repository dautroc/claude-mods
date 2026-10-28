# walkthrough: review items one at a time

Agreed with the person on 2026-10-28.

## Why

When a reply hands the person a list of sections that each need a decision or an action, they have to
read the whole reply to answer it. walkthrough puts the list in a pane that shows one item at a time,
with Claude's recommendation and the choices, the way plan mode's question dialog does, and sends
the answers back in one message.

## Decided

- **Trigger: a tool.** Claude calls `mcp__walkthrough__review_items` (registered `isDeferred: false`)
  with the items as data, instead of writing them in the reply. Each item has a title, a short
  Markdown body, a recommendation, 0–9 choices (each a label, an optional one-line detail and
  `recommended`), `multiSelect`, and an optional preview: `mermaid`, `markdown` (tables included),
  `code` or `diff`. Not a fenced block: reply-style answers every reply row without `next`, a fence
  would put the list back in the reply, and a schema parses more reliably than prose. The built-in
  question dialog stays for one to four quick questions mid-task.
- **The transcript row** of the tool call is drawn as a compact list of the item titles, with an
  open button.
- **The pane** docks beside the transcript (`columns` asked wide, the dock caps it at 45%), opened
  with `focus`. One item at a time: header with the review's title, `n / N` and a progress row;
  the item's title and body; the preview; `★ Recommended: …`; the choices as buttons with
  hotkeys `1`–`9`; a Note field; a key line.
- **Keys.** `1`–`9` pick and move to the next unanswered item (multi-select: toggle, `n` moves
  on); `w` puts the cursor in the Note field (a note with no pick is the person's own answer; with
  a pick it goes along); `p` back, `n` next; `t` cycles the diagram between picture, text and
  source; `v` opens the picture full size; `s` goes to the summary, where `s` sends and a digit
  jumps back to an item. Esc gives the keys back and keeps the progress; `/walk` or ctrl+x tab
  brings the pane back; closing it keeps the progress until sent.
- **Answers go back as the person's next message**, `$.prompt.submit({ asUser: true })`, one line
  per item. The tool returns at once and tells Claude to end its turn. A pane can't hold the tool
  call open: a hook has 10 s of its own time, and the only engine call that waits for the person is
  the built-in question dialog (4 questions of 4 choices, no picture).
- **Mermaid.** A bundled copy of beautiful-mermaid (MIT; elkjs EPL-2.0 and entities BSD-2 inside)
  runs under `node` through `$.process.run`: SVG, made a PNG by `rsvg-convert` once its CSS
  variables are resolved to colours, and a box-drawing text version. The picture is an `Image`
  scaled to the pane; the text version is the fallback, truncated at the pane's edge (a left-right
  flowchart also gets a top-down text version for a narrow pane). Pie, gantt and mindmap, which
  the library refuses, and a diagram that doesn't parse show as source; the tool's result names the
  ones that didn't parse.

## Left to the builder

- Colours of the diagram: from the theme's base and its `text` / `inverseText` overrides.
- A second `review_items` call replaces an unsent review; the result says so.
- State is the session's (`$.state`); `/clear` drops the review. Nothing goes to `$.store`.
