/**
 * Session log → timeline. One synchronous pass over the committed events; no
 * host services, so the same fold runs in the host route, in tests and in the
 * offline dump script.
 *
 * Span ids are assigned in the order the log opens them, so the id of a span
 * is a pure function of the log prefix that contains its opening event. That
 * is what lets the host answer a poll with only the spans changed since the
 * client's cursor.
 */
import { classifyJob, classifyTool, clip, parseArgs, type RuleSet } from './classify.ts'
import type {
  ModelSeg, SpanDetail, Timeline, TimelineDelta, TimelinePhase, TimelineSpan, TimelineStep, TimelineTurn,
} from './types.ts'

/** The subset of a dsh `SessionEvent` the fold reads. Unknown types pass through. */
export interface LogEvent {
  type: string
  seq: number
  time: number
  data?: unknown
}

export interface BuildOptions {
  sessionId: string
  /** The session is attached in the host. */
  live: boolean
  /** Host clock; the end of spans that are still executing. */
  now: number
  rules?: RuleSet
  /** Number of leading events inherited from a fork parent; they are skipped. */
  inherited?: number
}

type Rec = Record<string, unknown>

function rec(value: unknown): Rec {
  return value !== null && typeof value === 'object' ? value as Rec : {}
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    const text = rec(block).text
    if (typeof text === 'string') out += text
  }
  return out
}

/** Events that move the model-request start forward while a step awaits output. */
const PRE_REQUEST = new Set([
  'request/header', 'request/context', 'system/message', 'user/message', 'developer/message',
  'compaction/end', 'llm/retry-started',
])

/** Message sources that start a turn, as opposed to context injected alongside. */
const TURN_TRIGGERS = new Set([
  'user', 'schedule', 'goal', 'goal-round', 'agent-message', 'team-message', 'tool-jobs', 'subagent-settled',
])

/** A prompt phase shorter than this is folded into the first todo that follows it. */
const SHORT_PROMPT_MS = 60_000
/** A wrap-up shorter than this is folded into the todo it follows. */
const SHORT_WRAP_MS = 10_000

const SEG_OF_BLOCK: Record<string, ModelSeg['k']> = { reasoning: 'think', text: 'text', 'tool-call': 'call' }
const MAX_SEGS = 24

/** Split one model attempt into wait / think / text / call phases from its timed stream. */
function modelSegs(stream: unknown, start: number, end: number): { segs: ModelSeg[]; first: number } {
  if (!Array.isArray(stream)) return { segs: [], first: end }
  const segs: ModelSeg[] = []
  const open = new Map<number, { k: ModelSeg['k']; s: number }>()
  let first = Infinity
  let last = start
  const push = (k: ModelSeg['k'], s: number, e: number): void => {
    if (e <= s) return
    const prev = segs[segs.length - 1]
    if (prev !== undefined && prev.k === k && s - prev.e < 50) prev.e = e
    else if (segs.length < MAX_SEGS) segs.push({ k, s, e })
  }
  for (const raw of stream) {
    const record = rec(raw)
    if (record.type !== 'chunk') {
      const t0 = num(record.time0, NaN)
      if (Number.isNaN(t0)) continue
      first = Math.min(first, t0)
      let t = t0
      if (Array.isArray(record.dt)) for (const d of record.dt) t += num(d)
      last = Math.max(last, t)
      continue
    }
    const time = num(record.time, NaN)
    if (Number.isNaN(time)) continue
    const chunk = rec(record.chunk)
    if (chunk.type === 'usage' || chunk.type === 'finish') {
      last = Math.max(last, time)
      continue
    }
    first = Math.min(first, time)
    last = Math.max(last, time)
    const index = num(chunk.index, -1)
    if (chunk.type === 'block-start') {
      const k = SEG_OF_BLOCK[str(chunk.blockType)]
      if (k !== undefined) open.set(index, { k, s: time })
    } else if (chunk.type === 'block-end') {
      const block = open.get(index)
      if (block !== undefined) {
        open.delete(index)
        push(block.k, block.s, time)
      }
    }
  }
  for (const block of open.values()) push(block.k, block.s, Math.min(Math.max(last, block.s), end))
  segs.sort((a, b) => a.s - b.s)
  const firstToken = Math.min(first, end)
  if (firstToken > start) segs.unshift({ k: 'wait', s: start, e: firstToken })
  return { segs, first: firstToken }
}

function describeAssistant(message: Rec): string {
  const content = Array.isArray(message.content) ? message.content as unknown[] : []
  const calls: string[] = []
  let text = ''
  for (const raw of content) {
    const block = rec(raw)
    if (block.type === 'tool-call') calls.push(str(block.name))
    else if (block.type === 'text') text += str(block.text)
  }
  if (calls.length > 0) {
    const counts = new Map<string, number>()
    for (const name of calls) counts.set(name, (counts.get(name) ?? 0) + 1)
    return '→ ' + [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')
  }
  return clip(text, 140)
}

/**
 * Fold a session log into a timeline.
 * @param events - committed events in log order.
 * @param options - identity, liveness and the classification rules.
 * @returns the whole timeline at the log's cursor.
 */
export function buildTimeline(events: readonly LogEvent[], options: BuildOptions): Timeline {
  const rules = options.rules?.rules ?? []
  const spans: TimelineSpan[] = []
  const turns: TimelineTurn[] = []
  const steps: TimelineStep[] = []
  const phases: TimelinePhase[] = []

  const callSpans = new Map<string, TimelineSpan>()
  const jobSpans = new Map<string, TimelineSpan>()
  const approvalSpans = new Map<string, TimelineSpan>()
  const commandSpans = new Map<string, TimelineSpan>()
  /** Subagents by child session id; `span` is set while the child is working. */
  const agents = new Map<string, { label: string; span?: TimelineSpan }>()
  /** Tool calls whose result is logged, by call id; a job that settles later is a background process. */
  const returned = new Set<string>()
  const jobCall = new Map<string, string>()
  /** Open spans whose turn already ended: they keep the end they were frozen at. */
  const frozen = new Set<TimelineSpan>()

  let turn: TimelineTurn | undefined
  let step: TimelineStep | undefined
  let phase: TimelinePhase | undefined
  let compaction: TimelineSpan | undefined
  let awaitingModel = false
  let modelStart = 0
  let modelName = ''
  let title: string | undefined
  let cursor = -1
  let lastTime = 0
  let nextId = 0

  const open = (span: Omit<TimelineSpan, 'id' | 'e' | 'mod' | 'open'>): TimelineSpan => {
    const created: TimelineSpan = { ...span, id: nextId++, e: span.s, mod: span.seq, open: true }
    spans.push(created)
    return created
  }
  const close = (span: TimelineSpan, end: number, seq: number): void => {
    span.e = Math.max(end, span.s)
    span.mod = seq
    delete span.open
  }
  const closePhase = (time: number): void => {
    if (phase === undefined) return
    phase.e = Math.max(time, phase.s)
    const previous = phases[phases.length - 2]
    if (phase.src === 'wrap' && phase.e - phase.s < SHORT_WRAP_MS && previous !== undefined
      && previous.turn === phase.turn && previous.e === phase.s) {
      // A few seconds of sign-off after the last todo is still that todo.
      previous.e = phase.e
      phases.pop()
    } else if (phase.e - phase.s < 1 && phase.src !== 'todo') {
      phases.pop()
    }
    phase = undefined
  }
  const openPhase = (time: number, src: TimelinePhase['src'], label: string): void => {
    closePhase(time)
    phase = { s: time, e: time, turn: turn?.turn ?? 0, src, label }
    phases.push(phase)
  }

  const start = Math.max(0, options.inherited ?? 0)
  for (let i = start; i < events.length; i++) {
    const event = events[i] as LogEvent
    const { type, seq, time } = event
    const data = rec(event.data)
    cursor = seq
    if (time > lastTime) lastTime = time

    if (awaitingModel && PRE_REQUEST.has(type)) modelStart = time

    switch (type) {
      case 'turn/start': {
        turn = { turn: num(data.turn), s: time, e: time, open: true, label: '', steps: 0 }
        turns.push(turn)
        openPhase(time, 'prompt', '')
        break
      }
      case 'turn/end': {
        const ended = turn
        if (ended !== undefined) {
          ended.e = time
          delete ended.open
          const reason = str(rec(data.reason).kind)
          if (reason !== '') ended.reason = reason
        }
        // A call with no result when its turn ends never returns: freeze it here, still marked open.
        for (const span of [...callSpans.values(), ...approvalSpans.values()]) {
          span.e = Math.max(time, span.s)
          span.mod = seq
          frozen.add(span)
        }
        callSpans.clear()
        approvalSpans.clear()
        if (step?.open) {
          step.e = time
          step.mod = seq
          delete step.open
        }
        closePhase(time)
        awaitingModel = false
        turn = undefined
        step = undefined
        break
      }
      case 'step/start': {
        step = { id: steps.length, turn: num(data.turn), step: num(data.step), s: time, e: time, open: true, mod: seq }
        steps.push(step)
        if (turn !== undefined) turn.steps++
        awaitingModel = true
        modelStart = time
        break
      }
      case 'step/end': {
        if (step !== undefined) {
          step.e = time
          step.mod = seq
          delete step.open
        }
        awaitingModel = false
        break
      }
      case 'user/message': {
        // Injected context (runtime notices, skill catalogs, …) also arrives as user messages;
        // only a trigger names the turn, and a human prompt wins over any other trigger.
        const source = str(rec(data.source).kind)
        if (turn !== undefined && TURN_TRIGGERS.has(source) && (turn.label === '' || (source === 'user' && turn.source !== 'user'))) {
          const first = phase !== undefined && phase.src === 'prompt' && phase.label === turn.label
          turn.label = clip(textOf(data.content), 160)
          turn.source = source
          if (first && phase !== undefined) phase.label = turn.label
        }
        break
      }
      case 'request/context':
      case 'model/selection': {
        const model = str(data.model)
        if (model !== '') modelName = model
        break
      }
      case 'request/header': {
        const model = str(rec(rec(data.header).config).model)
        if (model !== '') modelName = model
        break
      }
      case 'assistant/attempt':
      case 'assistant/message': {
        const message = rec(data.message)
        const source = rec(message.source)
        const model = str(source.model) || modelName
        const failed = type === 'assistant/attempt'
        const s = Math.min(awaitingModel ? modelStart : (step?.s ?? time), time)
        const span = open({
          kind: 'model',
          cat: 'model',
          name: model || 'model',
          label: failed ? '' : describeAssistant(message),
          s,
          turn: num(data.turn, turn?.turn ?? 0),
          step: num(data.step, step?.step ?? 0),
          seq,
        })
        close(span, time, seq)
        const { segs, first } = modelSegs(data.stream, s, time)
        // An event logged mid-stream can push the request start past the first token.
        if (first < span.s) span.s = first
        if (segs.length > 0) span.segs = segs
        const usage = rec(data.usage)
        if (typeof usage.inputTokens === 'number' || typeof usage.outputTokens === 'number') {
          span.tok = { in: num(usage.inputTokens), out: num(usage.outputTokens) }
          const cached = num(usage.cachedInputTokens ?? usage.cacheReadTokens ?? usage.cachedTokens, -1)
          if (cached >= 0) span.tok.cached = cached
          const reasoning = num(usage.reasoningTokens, -1)
          if (reasoning >= 0) span.tok.reasoning = reasoning
        }
        if (failed || data.interrupted === true) span.err = true
        // A failed attempt is followed by a backoff and `llm/retry-started`, which re-arms the clock.
        awaitingModel = false
        break
      }
      case 'llm/retry-started': {
        awaitingModel = true
        modelStart = time
        break
      }
      case 'tool/call': {
        const callId = str(data.callId)
        const name = str(data.name)
        const { cat, label } = classifyTool(name, data.arguments, rules)
        const span = open({
          kind: 'tool', cat, name, label, s: time,
          turn: num(data.turn, turn?.turn ?? 0), step: num(data.step, step?.step ?? 0), seq,
        })
        callSpans.set(callId, span)
        // A message to a settled subagent puts it back to work.
        if (name === 'send_message') {
          const args = parseArgs(data.arguments)
          const agent = agents.get(str(args.agent_id) || str(args.agentId) || str(args.to))
          if (agent !== undefined && agent.span === undefined) {
            agent.span = open({
              kind: 'agent', cat: 'agent', name: 'subagent', label: agent.label, s: time,
              turn: span.turn, step: span.step, seq,
            })
          }
        }
        break
      }
      case 'subagent/catalog': {
        const childId = str(data.childId)
        const label = clip(str(data.label))
        const span = open({
          kind: 'agent', cat: 'agent', name: 'subagent', label, s: Math.min(num(data.childCreatedAt, time), time),
          turn: turn?.turn ?? 0, step: step?.step ?? 0, seq,
        })
        agents.set(childId, { label, span })
        break
      }
      case 'agent/inbox/spliced': {
        const inserted = Array.isArray(data.inserted) ? data.inserted as unknown[] : []
        for (const raw of inserted) {
          const source = rec(rec(raw).source)
          if (source.kind !== 'subagent-settled') continue
          const agent = agents.get(str(source.senderSessionId))
          if (agent?.span === undefined) continue
          close(agent.span, time, seq)
          agent.span = undefined
        }
        break
      }
      case 'tool/result': {
        const message = rec(data.message)
        const callId = str(message.toolCallId)
        const span = callSpans.get(callId)
        returned.add(callId)
        if (span === undefined) break
        callSpans.delete(callId)
        close(span, time, seq)
        if (message.isError === true) span.err = true
        // A process still running when its call returns is a background process.
        for (const [jobId, job] of jobSpans) {
          if (jobCall.get(jobId) === callId && job.open && !job.bg) {
            job.bg = true
            job.mod = seq
          }
        }
        break
      }
      case 'tool/ptc-dispatch-start': {
        const subId = str(data.subCallId)
        const name = str(data.name)
        const { cat, label } = classifyTool(name, data.arguments, rules)
        const parent = callSpans.get(str(data.parentCallId)) ?? callSpans.get(str(data.rootCallId))
        const span = open({
          kind: 'sub', cat, name, label, s: time,
          turn: parent?.turn ?? turn?.turn ?? 0, step: parent?.step ?? step?.step ?? 0, seq,
          ...(parent === undefined ? {} : { parent: parent.id }),
        })
        callSpans.set(subId, span)
        break
      }
      case 'tool/ptc-dispatch': {
        const subId = str(data.subCallId)
        const span = callSpans.get(subId)
        returned.add(subId)
        if (span === undefined) break
        callSpans.delete(subId)
        close(span, time, seq)
        if (data.isError === true || data.error !== undefined) span.err = true
        break
      }
      case 'job/registered': {
        const jobId = str(data.jobId)
        const kind = str(data.kind) || 'job'
        const label = clip(str(data.label))
        const callId = str(rec(data.toolCall).callId)
        const parent = callSpans.get(callId)
        const span = open({
          kind: 'job',
          cat: parent?.cat ?? classifyJob(kind, label, rules),
          name: kind,
          label,
          s: num(data.startedAt, time),
          turn: parent?.turn ?? turn?.turn ?? 0,
          step: parent?.step ?? step?.step ?? 0,
          seq,
          ...(parent === undefined ? {} : { parent: parent.id }),
        })
        jobSpans.set(jobId, span)
        jobCall.set(jobId, callId)
        if (callId === '' || returned.has(callId)) span.bg = true
        break
      }
      case 'job/settled': {
        const jobId = str(data.jobId)
        const span = jobSpans.get(jobId)
        if (span === undefined) break
        jobSpans.delete(jobId)
        jobCall.delete(jobId)
        close(span, num(data.finishedAt, time), seq)
        const status = str(data.status)
        if (status !== '' && status !== 'completed' && status !== 'killed') span.err = true
        break
      }
      case 'approval/asked': {
        const id = str(data.id)
        const parent = callSpans.get(str(data.callId))
        const span = open({
          kind: 'approval', cat: 'wait', name: str(data.toolName) || 'approval', label: clip(str(data.reason)),
          s: time, turn: parent?.turn ?? turn?.turn ?? 0, step: parent?.step ?? step?.step ?? 0, seq,
          ...(parent === undefined ? {} : { parent: parent.id }),
        })
        approvalSpans.set(id, span)
        break
      }
      case 'approval/decided': {
        const id = str(data.id)
        const span = approvalSpans.get(id)
        if (span === undefined) break
        approvalSpans.delete(id)
        close(span, time, seq)
        const outcome = str(data.outcome)
        if (outcome !== '') span.label = span.label === '' ? outcome : `${outcome} · ${span.label}`
        if (outcome.startsWith('denied') || outcome.startsWith('rejected')) span.err = true
        break
      }
      case 'compaction/start': {
        compaction = open({
          kind: 'compaction', cat: 'model', name: 'compaction', label: '', s: time,
          turn: turn?.turn ?? 0, step: step?.step ?? 0, seq,
        })
        break
      }
      case 'compaction/end': {
        if (compaction !== undefined) close(compaction, time, seq)
        compaction = undefined
        break
      }
      case 'command/run': {
        const span = open({
          kind: 'command', cat: 'other', name: '/' + str(data.name), label: clip(str(data.args)), s: time,
          turn: turn?.turn ?? 0, step: step?.step ?? 0, seq,
        })
        commandSpans.set(str(data.commandId), span)
        break
      }
      case 'command/done': {
        const id = str(data.commandId)
        const span = commandSpans.get(id)
        if (span === undefined) break
        commandSpans.delete(id)
        close(span, time, seq)
        if (data.kind === 'error') span.err = true
        break
      }
      case 'todo/write': {
        if (turn === undefined) break
        const todos = Array.isArray(data.todos) ? data.todos as unknown[] : []
        const active = todos.map(rec).find(todo => todo.status === 'in_progress')
        if (active !== undefined) {
          const label = clip(str(active.content), 160)
          if (phase !== undefined && phase.src === 'prompt' && time - phase.s < SHORT_PROMPT_MS) {
            // The moments between the prompt and the first plan belong to the plan's first item.
            phase.src = 'todo'
            phase.label = label
          } else if (phase === undefined || phase.src !== 'todo' || phase.label !== label) {
            openPhase(time, 'todo', label)
          }
        } else if (phase !== undefined && phase.src === 'todo') {
          openPhase(time, 'wrap', '')
        }
        break
      }
      case 'session/title': {
        const next = str(data.title)
        if (next !== '') title = next
        break
      }
      default:
        break
    }
  }

  // Whatever is still open: executing if the session is attached and mid-turn, abandoned otherwise.
  const running = options.live && turn !== undefined
  const horizon = running ? Math.max(options.now, lastTime) : lastTime
  for (const span of spans) {
    if (!span.open || frozen.has(span)) continue
    const alive = span.kind === 'job' || span.kind === 'agent' ? options.live : running
    span.e = Math.max(span.s, alive ? Math.max(options.now, lastTime) : Math.max(span.e, lastTime))
    if (alive) span.run = true
  }
  const openStep: TimelineStep | undefined = step
  if (openStep?.open) openStep.e = Math.max(openStep.s, horizon)
  const openTurn: TimelineTurn | undefined = turn
  if (openTurn !== undefined) openTurn.e = Math.max(openTurn.s, horizon)
  const openPhaseNow: TimelinePhase | undefined = phase
  if (openPhaseNow !== undefined) openPhaseNow.e = Math.max(openPhaseNow.s, horizon)

  // A foreground job duplicates its tool call; only processes that outlived their call are kept.
  const kept = spans.filter(span => span.kind !== 'job' || span.bg === true)

  let first = Infinity
  let last = 0
  for (const t of turns) {
    first = Math.min(first, t.s)
    last = Math.max(last, t.e)
  }
  for (const span of kept) {
    first = Math.min(first, span.s)
    // A still-running background process must not stretch a finished session to "now".
    if (!((span.kind === 'job' || span.kind === 'agent') && span.open && !running)) last = Math.max(last, span.e)
  }
  if (first === Infinity) {
    first = lastTime
    last = lastTime
  }

  return {
    v: 1,
    sessionId: options.sessionId,
    ...(title === undefined ? {} : { title }),
    cursor,
    live: options.live,
    running,
    now: options.now,
    start: first,
    end: Math.max(last, first),
    spans: kept,
    turns,
    steps,
    phases,
    categories: options.rules?.categories ?? [],
  }
}

/**
 * The part of a timeline a client holding `since` is missing.
 * @param timeline - the current whole timeline.
 * @param since - cursor of the timeline the client holds.
 * @returns changed spans and steps plus every small whole-valued field.
 */
export function deltaSince(timeline: Timeline, since: number): TimelineDelta {
  const { spans, steps, ...rest } = timeline
  return {
    ...rest,
    spans: spans.filter(span => span.mod > since || span.open === true),
    steps: steps.filter(step => step.mod > since || step.open === true),
  }
}

/**
 * Apply a delta to the timeline it was computed against.
 * @param base - the timeline the client holds.
 * @param delta - changes since `base.cursor`.
 * @returns the timeline at `delta.cursor`.
 */
export function applyDelta(base: Timeline, delta: TimelineDelta): Timeline {
  const byId = new Map<number, TimelineSpan>()
  for (const span of base.spans) byId.set(span.id, span)
  for (const span of delta.spans) byId.set(span.id, span)
  const spans = [...byId.values()].sort((a, b) => a.id - b.id)
  const steps = base.steps.slice()
  for (const step of delta.steps) steps[step.id] = step
  return { ...delta, spans, steps }
}

const DETAIL_MAX = 24_000

function cut(text: string, detail: SpanDetail): string {
  if (text.length <= DETAIL_MAX) return text
  detail.truncated = true
  return text.slice(0, DETAIL_MAX)
}

function pretty(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw
    }
  }
  if (raw === undefined) return ''
  try {
    return JSON.stringify(raw, null, 2)
  } catch {
    return String(raw)
  }
}

/**
 * Arguments and result of the span opened by the event at `seq`.
 * @param events - committed events in log order.
 * @param seq - seq of the span's opening event.
 * @returns the detail, or null when no span opens there.
 */
export function spanDetail(events: readonly LogEvent[], seq: number): SpanDetail | null {
  let index = seq
  if (events[index]?.seq !== seq) index = events.findIndex(event => event.seq === seq)
  const event = events[index]
  if (event === undefined) return null
  const data = rec(event.data)
  const detail: SpanDetail = { seq }
  switch (event.type) {
    case 'tool/call': {
      detail.args = cut(pretty(data.arguments), detail)
      const callId = str(data.callId)
      for (let i = index + 1; i < events.length; i++) {
        const later = events[i] as LogEvent
        if (later.type !== 'tool/result') continue
        const message = rec(rec(later.data).message)
        if (str(message.toolCallId) !== callId) continue
        detail.result = cut(textOf(message.content), detail)
        if (message.isError === true) detail.isError = true
        const code = str(rec(rec(later.data).error).code)
        if (code !== '') detail.errorCode = code
        break
      }
      return detail
    }
    case 'tool/ptc-dispatch-start': {
      detail.args = cut(pretty(data.arguments), detail)
      return detail
    }
    case 'assistant/message':
    case 'assistant/attempt': {
      const content = rec(data.message).content
      let text = ''
      let reasoning = ''
      const calls: string[] = []
      if (Array.isArray(content)) {
        for (const raw of content) {
          const block = rec(raw)
          if (block.type === 'text') text += str(block.text)
          else if (block.type === 'reasoning') reasoning += str(block.text)
          else if (block.type === 'tool-call') calls.push(str(block.name))
        }
      }
      if (text !== '') detail.text = cut(text, detail)
      if (reasoning !== '') detail.reasoning = cut(reasoning, detail)
      if (calls.length > 0) detail.calls = calls
      if (event.type === 'assistant/attempt' && Array.isArray(data.stream)) {
        for (const raw of data.stream) {
          const failure = rec(rec(rec(rec(raw).chunk).reason).failure)
          const message = str(failure.message)
          if (message !== '') {
            detail.result = cut(message, detail)
            detail.isError = true
            const code = str(failure.code)
            if (code !== '') detail.errorCode = code
          }
        }
      }
      return detail
    }
    case 'job/registered': {
      detail.args = cut(str(data.label), detail)
      const jobId = str(data.jobId)
      for (let i = index + 1; i < events.length; i++) {
        const later = events[i] as LogEvent
        if (later.type === 'job/settled' && str(rec(later.data).jobId) === jobId) {
          const settled = rec(later.data)
          detail.result = [str(settled.status), str(settled.detail)].filter(Boolean).join(' · ')
          break
        }
      }
      return detail
    }
    case 'approval/asked': {
      detail.args = cut(str(data.reason), detail)
      return detail
    }
    case 'subagent/catalog': {
      detail.args = [str(data.label), `session ${str(data.childId)}`, str(data.mode)].filter(Boolean).join('\n')
      return detail
    }
    case 'command/run': {
      detail.args = `/${str(data.name)}${str(data.args)}`
      const id = str(data.commandId)
      for (let i = index + 1; i < events.length; i++) {
        const later = events[i] as LogEvent
        if (later.type === 'command/done' && str(rec(later.data).commandId) === id) {
          detail.result = cut(str(rec(later.data).text), detail)
          break
        }
      }
      return detail
    }
    default:
      return null
  }
}
