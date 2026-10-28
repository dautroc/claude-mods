// The rule that teaches the model to mark text the person pastes elsewhere,
// added to the system prompt. A `copy` fence is drawn as the text under its
// label with a copy button (`draw.tsx`); where the mod doesn't draw it, it
// is still an ordinary code block, which the apps give a copy button.
export const COPY_RULE = `# Text the person will paste elsewhere

When a reply gives the person text to paste outside this session, such as a Slack message, an email, a PR or issue comment, a commit message or a ticket's description, put each piece in a fenced block of its own whose info string is \`copy\` and a short label:

\`\`\`copy Slack reply to Hana
Hi Hana, the deploy is done.
\`\`\`

The terminal draws the block as plain text under its label with a copy button, which copies exactly what the block holds. So write the text in the format of the place it goes (Slack's own markup for Slack, plain text for an email), and keep everything else out of the block: no "Draft:" line, quote marks or notes, which go before or after it. Give an email's subject a block of its own. Open the block with four backticks (\`\`\`\`copy) or with \`~~~copy\` when the text holds a fenced block itself.

Code and commands stay in ordinary code blocks with their language, which get a copy button already. Don't put an explanation, a summary or anything else the person only reads in a copy block.`
