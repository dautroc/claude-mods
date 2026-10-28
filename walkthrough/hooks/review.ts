import type { Answer, Choice, Item, Preview, PreviewKind, Review } from '../types'

export const MAX_ITEMS = 20
export const MAX_CHOICES = 9
const KINDS: readonly PreviewKind[] = ['mermaid', 'markdown', 'code', 'diff']

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what} must be a non-empty string.`)
  }

  return value.trim()
}

function optionalText(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`${what} must be a string.`)
  }

  return value.trim() === '' ? undefined : value.trim()
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be an object.`)
  }

  return value as Record<string, unknown>
}

function parseChoice(value: unknown, what: string): Choice {
  const raw = record(value, what)
  const detail = optionalText(raw.detail, `${what}.detail`)

  return {
    label: text(raw.label, `${what}.label`),
    ...(detail === undefined ? {} : { detail }),
    ...(raw.recommended === true ? { recommended: true as const } : {}),
  }
}

function parsePreview(value: unknown, what: string): Preview | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  const raw = record(value, what)
  if (!KINDS.includes(raw.kind as PreviewKind)) {
    throw new Error(`${what}.kind must be one of ${KINDS.join(', ')}.`)
  }
  if (typeof raw.source !== 'string' || raw.source.trim() === '') {
    throw new Error(`${what}.source must be a non-empty string.`)
  }
  const language = optionalText(raw.language, `${what}.language`)

  return { kind: raw.kind as PreviewKind, source: raw.source, ...(language === undefined ? {} : { language }) }
}

function parseItem(value: unknown, n: number): Item {
  const what = `items[${n}]`
  const raw = record(value, what)
  const choices = raw.choices ?? []
  if (!Array.isArray(choices) || choices.length > MAX_CHOICES) {
    throw new Error(`${what}.choices must be a list of at most ${MAX_CHOICES} choices.`)
  }
  const body = optionalText(raw.body, `${what}.body`)
  const recommendation = optionalText(raw.recommendation, `${what}.recommendation`)
  const preview = parsePreview(raw.preview, `${what}.preview`)

  return {
    title: text(raw.title, `${what}.title`),
    ...(body === undefined ? {} : { body }),
    ...(recommendation === undefined ? {} : { recommendation }),
    choices: choices.map((choice, k) => parseChoice(choice, `${what}.choices[${k}]`)),
    ...(raw.multiSelect === true && choices.length > 0 ? { multiSelect: true as const } : {}),
    ...(preview === undefined ? {} : { preview }),
  }
}

// The review a `review_items` call asks for, or an error saying what in its
// input is wrong.
export function parseReview(input: Record<string, unknown>, id: string): Review {
  const items = input.items
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    throw new Error(`items must be a list of 1 to ${MAX_ITEMS} items.`)
  }

  return {
    id,
    title: text(input.title, 'title'),
    items: items.map(parseItem),
    answers: items.map(() => ({ picked: [], note: '' })),
    at: 0,
  }
}

export function isAnswered(answer: Answer | undefined): boolean {
  return answer !== undefined && (answer.picked.length > 0 || answer.note.trim() !== '')
}

export function answeredCount(review: Review): number {
  return review.answers.filter(isAnswered).length
}

export function isSummary(review: Review): boolean {
  return review.at >= review.items.length
}

// Where the pane goes once item `from` is answered: the next unanswered item
// after it, else the summary.
export function nextUnanswered(review: Review, from: number): number {
  for (let at = from + 1; at < review.items.length; at++) {
    if (!isAnswered(review.answers[at])) {
      return at
    }
  }

  return review.items.length
}

function withAnswer(review: Review, at: number, fn: (answer: Answer) => Answer): Review {
  return { ...review, answers: review.answers.map((answer, k) => (k === at ? fn(answer) : answer)) }
}

function isChoice(review: Review, choice: number): boolean {
  const item = review.items[review.at]

  return item !== undefined && choice >= 0 && choice < item.choices.length
}

// Space on choice `choice` of the item shown: on a single-choice item it
// becomes the answer, on a multi-select one it is toggled; the pane stays.
export function mark(review: Review, choice: number): Review {
  if (!isChoice(review, choice)) {
    return review
  }
  if (review.items[review.at]!.multiSelect !== true) {
    return withAnswer(review, review.at, answer => ({ ...answer, picked: [choice] }))
  }

  return withAnswer(review, review.at, answer => ({
    ...answer,
    picked: answer.picked.includes(choice)
      ? answer.picked.filter(k => k !== choice)
      : [...answer.picked, choice].sort((a, b) => a - b),
  }))
}

// Enter on choice `choice` of the item shown: on a single-choice item it is
// the answer; a multi-select one keeps what Space marked, or takes this one
// when nothing is. The pane moves on to the next unanswered item.
export function submit(review: Review, choice: number): Review {
  if (!isChoice(review, choice)) {
    return review
  }

  const multi = review.items[review.at]!.multiSelect === true
  const answered = withAnswer(review, review.at, answer =>
    multi && answer.picked.length > 0 ? answer : { ...answer, picked: [choice] },
  )

  return { ...answered, at: nextUnanswered(answered, review.at) }
}

// The choice the ring starts on in the item shown: the one picked, else the
// one recommended, else the first.
export function defaultChoice(review: Review): number {
  const item = review.items[review.at]
  if (item === undefined) {
    return 0
  }

  return review.answers[review.at]?.picked[0] ?? Math.max(0, item.choices.findIndex(c => c.recommended === true))
}

// The elements j and k walk: the item's choices, or on the summary its items
// and Send.
export function ringKeys(review: Review): string[] {
  if (isSummary(review)) {
    return [...review.items.map((_, k) => `item-${k}`), 'send']
  }

  return review.items[review.at]!.choices.map((_, k) => `choice-${k}`)
}

// Where j (`by` 1) or k (-1) takes the ring from `ring`, held to the ends;
// from an element they don't walk, to `fallback`.
export function stepRing(keys: readonly string[], ring: string | undefined, fallback: string, by: number): string {
  const now = ring === undefined ? -1 : keys.indexOf(ring)
  if (now < 0) {
    return fallback
  }

  return keys[Math.max(0, Math.min(keys.length - 1, now + by))]!
}

export function setNote(review: Review, note: string): Review {
  return isSummary(review) ? review : withAnswer(review, review.at, answer => ({ ...answer, note }))
}

// The item shown moved to `at`, held between the first item and the summary.
export function goTo(review: Review, at: number): Review {
  return { ...review, at: Math.max(0, Math.min(review.items.length, at)) }
}

// An answer as one line of the message the person sends.
export function answerText(item: Item, answer: Answer): string {
  const note = answer.note.trim().replace(/\n+/g, ' ')
  if (answer.picked.length === 0) {
    if (note === '') {
      return 'skipped'
    }

    return item.choices.length === 0 ? note : `none of the choices: ${note}`
  }

  const labels = answer.picked.map(k => {
    const choice = item.choices[k]!

    return choice.recommended === true ? `${choice.label} (recommended)` : choice.label
  })

  return note === '' ? labels.join(', ') : `${labels.join(', ')}. Note: ${note}`
}

// The message that carries the answers back to Claude, one line per item.
export function answersMessage(review: Review): string {
  const lines = review.items.map((item, k) => `${k + 1}. ${item.title}: ${answerText(item, review.answers[k]!)}`)

  return [`Review answers · ${review.title}`, '', ...lines].join('\n')
}

// What the tool answers Claude once the review is in the pane.
export function openedText(
  review: Review,
  { replaced, isPlaced, undrawn }: { replaced?: string; isPlaced: boolean; undrawn: { at: number; why: string }[] },
): string {
  const n = review.items.length
  const lines = [
    `The person has the review "${review.title}" (${n} item${n === 1 ? '' : 's'}) in the walkthrough pane beside the chat, one item at a time with your recommendation and choices.`,
    "Don't repeat the items in your reply: end your turn now with one short line saying the review is open. Their answers arrive as their next message, one line per item.",
  ]
  if (!isPlaced) {
    lines.push('The pane could not open on screen yet; the person opens it with /walk.')
  }
  if (replaced !== undefined) {
    lines.push(`It replaces the review "${replaced}", which they had not sent.`)
  }
  for (const { at, why } of undrawn) {
    lines.push(`The diagram of item ${at + 1} could not be drawn (${why}); the pane shows its source.`)
  }

  return lines.join('\n')
}
