import { atom, update } from 'claude-code'
import type { Register } from 'claude-code'

import { SHAPE } from './state'

export const register: Register = on => {
  // Records when a main-loop tool call starts and ends. A fault here never
  // blocks the call: the tool runs and answers as it would without the mod.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      return next(e)
    }

    const call = atom({ plugin: 'progress-bars', key: 'calls', id: e.tool_use_id } as const, null, { shape: SHAPE })
    const start = await $.clock.now()
    await update($, call, () => ({ start }))
    try {
      return await next(e)
    } finally {
      const end = await $.clock.now()
      await update($, call, () => ({ start, end }))
    }
  }).catch(($, e, next) => next(e))
}
