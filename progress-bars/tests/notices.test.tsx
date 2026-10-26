import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { engine } from './helpers'

const T0 = 1_800_000_000_000

function iso(ms: number) {
  return new Date(ms).toISOString()
}

// One line of a session file: the assistant's call of a tool named `name`.
function toolUseLine(id: string, name: string, at: number) {
  return JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
    type: 'assistant',
    uuid: `u-${id}`,
    timestamp: iso(at),
  })
}

// One line of a session file: a user prompt saved with its origin.
function promptLine(uuid: string, origin: Record<string, unknown>) {
  return JSON.stringify({
    type: 'user',
    uuid,
    origin,
    message: { role: 'user', content: 'hi' },
    timestamp: iso(T0),
  })
}

// Answers `find` with the session file, and every `grep` with `lines`. Returns
// the commands the engine ran, as their argv.
function answerProcesses(on: On, session: string, lines: string) {
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const isFind = e.argv[0] === 'find'
    const stdout = isFind ? `/home/u/.claude/projects/p/${session}.jsonl\n` : lines

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return ran
}

function sessionOn(on: On, session: string) {
  on('session.id', () => ({ value: session }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
}

// Launches a background agent from the main loop, and returns the tool call
// that started it.
async function launchAgent($: Engine, on: On, agentId: string) {
  let toolUseId = ''
  on('tool.call', { tool: 'Agent' }, (_, e) => {
    toolUseId = e.tool_use_id

    return { result: { status: 'async_launched', agentId, description: 'd' } }
  })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)

  return toolUseId
}

// A task-notification row for a background task.
function notice(task: { id?: string; toolUseId?: string }) {
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
    answerProcesses(on, 'S-notice-state', '')
    const toolUseId = await launchAgent($, on, 'ag-notice-state')

    const ui = await mountRow($, 'notice-state-row', notice({ id: 'ag-notice-state', toolUseId }))
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  })

  test("matched by the session file's tool_use, which names Agent", async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-notice-file')
    answerProcesses(on, 'S-notice-file', `${toolUseLine('toolu_notice_file', 'Agent', T0)}\n`)

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
    answerProcesses(on, 'S-handback', `${promptLine('peer-handback-1', { kind: 'peer', handback: true })}\n`)

    const ui = await mountRow($, 'peer-handback-1', peer('general-purpose'))
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  })
})

describe('kept as the engine draws them', () => {
  test("a background shell's notice, whose launching call is Bash", async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-shell')
    answerProcesses(on, 'S-shell', `${toolUseLine('toolu_shell_1', 'Bash', T0)}\n`)

    const ui = await mountRow($, 'shell-row-1', notice({ id: 'bsh-1', toolUseId: 'toolu_shell_1' }))
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('a peer row with no handback, which is another session', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-other-session')
    answerProcesses(on, 'S-other-session', `${promptLine('peer-other-1', { kind: 'peer' })}\n`)

    const ui = await mountRow($, 'peer-other-1', peer('other-session'))
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  for (const origin of [{ kind: 'composer' }, { kind: 'bridge' }, { kind: 'channel' }, { kind: 'plugin' }]) {
    test(`a ${origin.kind} row passes through untouched`, async ($, on) => {
      mock.clock(on, { now: T0 })
      engine(on)
      const ran = answerProcesses(on, `S-origin-${origin.kind}`, '')
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
    answerProcesses(on, 'S-expanded-peer', `${promptLine('peer-expanded-1', { kind: 'peer', handback: true })}\n`)

    const ui = await mountRow($, 'peer-expanded-1', { ...peer('general-purpose'), isExpanded: true })
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('a hand-back report on a desktop surface keeps the engine drawing', async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-desktop-peer')
    answerProcesses(on, 'S-desktop-peer', `${promptLine('peer-desktop-1', { kind: 'peer', handback: true })}\n`)

    const ui = await mountRow($, 'peer-desktop-1', peer('general-purpose'), 'desktop')
    expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await ui.unmount()
  })
})

describe('the notice lookup is remembered', () => {
  test("two renders of a background shell's notice inside 10 s run grep once", async ($, on) => {
    mock.clock(on, { now: T0 })
    engine(on)
    sessionOn(on, 'S-shell-cache')
    const ran = answerProcesses(on, 'S-shell-cache', `${toolUseLine('toolu_shell_cache', 'Bash', T0)}\n`)
    const props = notice({ id: 'bsh-cache', toolUseId: 'toolu_shell_cache' })

    const first = await mountRow($, 'shell-cache-row', props)
    await first.unmount()
    const second = await mountRow($, 'shell-cache-row', props)
    expect((await second.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
    await second.unmount()

    expect(ran.filter(argv => argv[0] === 'grep')).toHaveLength(1)
  })
})
