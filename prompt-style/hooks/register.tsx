import type { PromptOrigin, Register } from 'claude-code'

// The person's own prompt: typed here, or sent from Remote Control. Every
// other user row (a notification, another session's message) is the engine's.
function isOwn(origin: PromptOrigin): boolean {
  return origin.kind === 'composer' || origin.kind === 'bridge'
}

export const register: Register = on => {
  // On the terminal, the prompt sits beside an orange bar instead of on the
  // engine's full-width band, with the same blank line above it. The other
  // surfaces draw a prompt their own way, so they keep it.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (e.surface !== 'terminal' || !isOwn(e.props.origin)) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box marginTop={1}>
        <Box width={1} backgroundColor="claude" />
        <Box flexShrink={1} paddingLeft={1}>
          <Text color="text">{e.props.text}</Text>
        </Box>
      </Box>
    )
  })
}
