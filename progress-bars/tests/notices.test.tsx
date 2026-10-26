import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { answerProcesses, engine, launchAgent, promptLine, sessionOn, toolUseLine, uid } from './helpers'

const T0 = 1_800_000_000_000

// A task-notification row for a background task.
function notice(task: { id?: string; toolUseId?: string; type?: string }) {
  return { text: 'done', origin: { kind: 'task-notification' }, isExpanded: false, task: { ...task, status: 'completed' } }
}

// A peer row, as the engine stores it under its uuid.
function peer(from: string) {
  return { text: 'report', origin: { kind: 'peer' }, isExpanded: false, from: { name: from } }
}

async function mountRow($: Engine, requestId: string, props: Record<string, unknown>, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({
    plugin: 'progress-bars',
    surface,
    component: 'UserMessage',
    requestId,
    props: { text: 'hi', isExpanded: false, ...props },
  } as never)
}

describe("an agent's finished notice is hidden", () => {
  test('matched by the agent that the state recorded', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-notice-state')
    answerProcesses(on, 'S-notice-state')
    const toolUseId = await launchAgent($, on, 'ag-notice-state')

    const ui = await mountRow($, 'notice-state-row', notice({ id: 'ag-notice-state', toolUseId }))
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  })

  test("matched by the session file's tool_use, which names Agent", async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-notice-file')
    answerProcesses(on, 'S-notice-file', { text: `${toolUseLine('toolu_notice_file', 'Agent', T0)}\n` })

    const ui = await mountRow($, 'notice-file-row', notice({ id: 'ag-notice-file', toolUseId: 'toolu_notice_file' }))
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  })
})

describe("an agent's hand-back report is hidden", () => {
  test('a peer row whose saved entry has handback set', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-handback')
    answerProcesses(on, 'S-handback', { text: `${promptLine(uid(1), { kind: 'peer', handback: true })}\n` })

    const ui = await mountRow($, uid(1), peer('general-purpose'))
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  })
})

describe('kept as the engine draws them', () => {
  test("a background shell's notice, whose launching call is Bash", async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-shell')
    answerProcesses(on, 'S-shell', { text: `${toolUseLine('toolu_shell_1', 'Bash', T0)}\n` })

    const ui = await mountRow($, 'shell-row-1', notice({ id: 'bsh-1', toolUseId: 'toolu_shell_1' }))
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test("a remote agent's notice, whose launching call names Agent", async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-remote')
    answerProcesses(on, 'S-remote', { text: `${toolUseLine('toolu_remote_1', 'Agent', T0)}\n` })

    const ui = await mountRow($, 'remote-row-1', notice({ id: 'rem-1', toolUseId: 'toolu_remote_1', type: 'remote_agent' }))
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('a peer row with no handback, which is another session', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-other-session')
    answerProcesses(on, 'S-other-session', { text: `${promptLine(uid(2), { kind: 'peer' })}\n` })

    const ui = await mountRow($, uid(2), peer('other-session'))
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  for (const origin of [{ kind: 'composer' }, { kind: 'bridge' }, { kind: 'channel' }, { kind: 'plugin' }]) {
    test(`a ${origin.kind} row passes through untouched`, async ($, on) => {
      mock.clock(on, { now: T0 })
      engine(on)
      const ran = answerProcesses(on, `S-origin-${origin.kind}`)
      sessionOn(on, `S-origin-${origin.kind}`)

      const ui = await mountRow($, `origin-${origin.kind}-row`, { origin })
      expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
      expect(ran).toEqual([])
      await ui.unmount()
    })
  }

  test('a hand-back report that is expanded keeps the engine drawing', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-expanded-peer')
    answerProcesses(on, 'S-expanded-peer', { text: `${promptLine(uid(3), { kind: 'peer', handback: true })}\n` })

    const ui = await mountRow($, uid(3), { ...peer('general-purpose'), isExpanded: true })
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('a hand-back report on a desktop surface keeps the engine drawing', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-desktop-peer')
    answerProcesses(on, 'S-desktop-peer', { text: `${promptLine(uid(4), { kind: 'peer', handback: true })}\n` })

    const ui = await mountRow($, uid(4), peer('general-purpose'), 'desktop')
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })
})

describe('the notice lookup is remembered', () => {
  test("two renders of a background shell's notice run one scan", async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-shell-cache')
    const ran = answerProcesses(on, 'S-shell-cache', { text: `${toolUseLine('toolu_shell_cache', 'Bash', T0)}\n` })
    const props = notice({ id: 'bsh-cache', toolUseId: 'toolu_shell_cache' })

    const first = await mountRow($, 'shell-cache-row', props)
    await first.unmount()
    const second = await mountRow($, 'shell-cache-row', props)
    expect((await second.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await second.unmount()

    expect(ran.filter(argv => argv[0] === 'rg')).toHaveLength(1)
  })
})
