/**
 * Wire types shared by the host half (which folds a session log into a trace)
 * and the browser half (which draws it). Field names are short on purpose:
 * a long session carries thousands of spans.
 */

/** Built-in lane ids, in display order. Custom categories come before them. */
export const BUILTIN_CATEGORIES = [
  'model', 'build', 'shell', 'vcs', 'read', 'edit', 'web', 'vision', 'agent', 'mcp', 'wait', 'other',
] as const

export type BuiltinCategory = typeof BUILTIN_CATEGORIES[number]

/** What produced a span. */
export type SpanKind =
  /** One model attempt inside a step. */
  | 'model'
  /** A model-requested tool call. */
  | 'tool'
  /** A nested call dispatched by a programmatic tool (run_code). */
  | 'sub'
  /** A process that outlived the tool call that started it. */
  | 'job'
  /** A delegated subagent, from launch until it reports that it has settled. */
  | 'agent'
  /** Time spent waiting for the user to approve a call. */
  | 'approval'
  /** Context compaction. */
  | 'compaction'
  /** A human slash command. */
  | 'command'

/** One phase of a model attempt. */
export interface ModelSeg {
  /** wait = time to first token, think = reasoning, text = answer, call = tool-call arguments. */
  k: 'wait' | 'think' | 'text' | 'call'
  s: number
  e: number
}

export interface TokenUse {
  in: number
  out: number
  cached?: number
  reasoning?: number
}

export interface TraceSpan {
  /** Stable for a given log prefix: the n-th span opened by the log. */
  id: number
  kind: SpanKind
  /** Lane id: a built-in category or a custom one from config. */
  cat: string
  /** Tool name, model id, or job kind. */
  name: string
  /** Short human description: the command, the file, the query. */
  label: string
  /** Start, epoch ms. */
  s: number
  /** End, epoch ms. For an open span this is the snapshot time. */
  e: number
  turn: number
  step: number
  /** Seq of the event that opened the span; the detail route is keyed on it. */
  seq: number
  /** Seq of the last event that changed the span; drives delta responses. */
  mod: number
  /** Id of the enclosing span (sub → tool, job → tool, approval → tool). */
  parent?: number
  /** No closing event was logged. */
  open?: true
  /** Open and still executing in a live session (as opposed to abandoned). */
  run?: true
  err?: true
  /** A background process: it kept running after its tool call returned. */
  bg?: true
  segs?: ModelSeg[]
  tok?: TokenUse
}

export interface TraceTurn {
  turn: number
  s: number
  e: number
  open?: true
  /** Turn end reason kind: completed, aborted, error, … */
  reason?: string
  /** Head of the message that started the turn. */
  label: string
  /** What queued the turn: user, schedule, agent-message, … */
  source?: string
  steps: number
}

export interface TraceStep {
  /** Index in the steps array. */
  id: number
  turn: number
  step: number
  s: number
  e: number
  open?: true
  mod: number
}

export interface TracePhase {
  s: number
  e: number
  turn: number
  /**
   * todo = the in-progress todo item, prompt = the turn's opening message,
   * wrap = after every todo was completed.
   */
  src: 'todo' | 'prompt' | 'wrap'
  label: string
}

export interface CustomCategory {
  id: string
  label: string
  color?: string
}

export interface Trace {
  v: 1
  sessionId: string
  title?: string
  /** Seq of the last event folded in; -1 for an empty log. */
  cursor: number
  /** The session is attached in the host (it may still be idle). */
  live: boolean
  /** A turn is in progress. */
  running: boolean
  /** Host clock when the trace was built. */
  now: number
  /** First activity, epoch ms. */
  start: number
  /** Last activity (or `now` while running), epoch ms. */
  end: number
  spans: TraceSpan[]
  turns: TraceTurn[]
  steps: TraceStep[]
  phases: TracePhase[]
  /** Config-defined lanes, in config order. */
  categories: CustomCategory[]
}

/** Request body of the trace route. */
export interface TraceRequest {
  sessionId: string
  /** Cursor of the trace the client already holds. */
  since?: number
}

/** Changes to apply on top of the trace the client holds at `since`. */
export interface TraceDelta extends Omit<Trace, 'spans' | 'steps'> {
  /** Spans created or changed after `since`, plus every open span. */
  spans: TraceSpan[]
  /** Steps created or changed after `since`. */
  steps: TraceStep[]
}

export type TraceResponse =
  | { ok: true; mode: 'full'; trace: Trace }
  | { ok: true; mode: 'delta'; delta: TraceDelta }
  | { ok: true; mode: 'unchanged'; live: boolean; running: boolean; now: number }
  | { ok: true; mode: 'missing' }
  | { ok: false; error: { code: string; message: string } }

/** Request body of the span detail route. */
export interface SpanDetailRequest {
  sessionId: string
  seq: number
}

export interface SpanDetail {
  seq: number
  /** Raw tool arguments (pretty-printed JSON when parseable). */
  args?: string
  /** Model-facing result text. */
  result?: string
  isError?: boolean
  errorCode?: string
  /** Assistant text of a model span. */
  text?: string
  /** Reasoning text of a model span. */
  reasoning?: string
  /** Tool calls a model span requested. */
  calls?: string[]
  /** A field above was cut to fit. */
  truncated?: boolean
}

export type SpanDetailResponse =
  | { ok: true; detail: SpanDetail | null }
  | { ok: false; error: { code: string; message: string } }

export const TRACE_ROUTE = 'api/dsh-session-trace/trace'
export const DETAIL_ROUTE = 'api/dsh-session-trace/span'
