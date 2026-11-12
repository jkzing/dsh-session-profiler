/**
 * Timing statistics over a timeline. Pure; runs wherever the timeline is.
 *
 * The headline split partitions the time inside turns, so the parts add up:
 * waiting on the user wins over tool execution, which wins over model time,
 * and whatever is left is harness overhead between events.
 */
import type { Timeline, TimelineSpan } from './types.ts'

export interface CategoryStat {
  cat: string
  /** Calls in the lane (background processes are counted in `bg`). */
  n: number
  /** Sum of call durations. */
  sum: number
  /** Wall time covered by at least one call. */
  busy: number
  max: number
  err: number
  bg: number
}

export interface ToolStat {
  name: string
  cat: string
  n: number
  sum: number
  max: number
  err: number
}

export interface TimelineStats {
  /** First activity to last activity. */
  wall: number
  /** Time inside turns. */
  active: number
  /** Time between turns. */
  idle: number
  model: number
  tool: number
  /** Approvals and questions: the agent was blocked on the user. */
  wait: number
  /** Inside a turn but covered by no span. */
  overhead: number
  cats: CategoryStat[]
  tools: ToolStat[]
  tokensIn: number
  tokensOut: number
  /** Mean time to first token over model attempts that streamed. */
  ttft: number
  modelCalls: number
  toolCalls: number
  errors: number
}

type Interval = readonly [number, number]

/** Total length covered by a set of intervals. */
export function unionLength(intervals: Interval[]): number {
  if (intervals.length === 0) return 0
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0])
  let total = 0
  let [start, end] = sorted[0] as Interval
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i] as Interval
    if (s > end) {
      total += end - start
      start = s
      end = e
    } else if (e > end) {
      end = e
    }
  }
  return total + (end - start)
}

function isWait(span: TimelineSpan): boolean {
  return span.cat === 'wait'
}

export function summarize(timeline: Timeline): TimelineStats {
  const cats = new Map<string, CategoryStat & { spans: Interval[] }>()
  const tools = new Map<string, ToolStat>()
  const wait: Interval[] = []
  const tool: Interval[] = []
  const model: Interval[] = []
  let tokensIn = 0
  let tokensOut = 0
  let ttftSum = 0
  let ttftCount = 0
  let modelCalls = 0
  let toolCalls = 0
  let errors = 0

  for (const span of timeline.spans) {
    let cat = cats.get(span.cat)
    if (cat === undefined) {
      cat = { cat: span.cat, n: 0, sum: 0, busy: 0, max: 0, err: 0, bg: 0, spans: [] }
      cats.set(span.cat, cat)
    }
    const duration = span.e - span.s
    if (span.kind === 'job') {
      cat.bg++
      continue
    }
    cat.n++
    cat.sum += duration
    if (duration > cat.max) cat.max = duration
    if (span.err) {
      cat.err++
      errors++
    }
    cat.spans.push([span.s, span.e])

    if (span.kind === 'model' || span.kind === 'compaction') {
      model.push([span.s, span.e])
      if (span.kind === 'model') {
        modelCalls++
        tokensIn += span.tok?.in ?? 0
        tokensOut += span.tok?.out ?? 0
        const first = span.segs?.[0]
        if (first !== undefined && first.k === 'wait') {
          ttftSum += first.e - first.s
          ttftCount++
        }
      }
    } else if (isWait(span)) {
      wait.push([span.s, span.e])
    } else if (span.kind !== 'command' && span.kind !== 'agent') {
      tool.push([span.s, span.e])
      if (span.kind === 'tool') toolCalls++
    }

    if (span.kind === 'tool' || span.kind === 'sub') {
      const key = span.name
      let stat = tools.get(key)
      if (stat === undefined) {
        stat = { name: span.name, cat: span.cat, n: 0, sum: 0, max: 0, err: 0 }
        tools.set(key, stat)
      }
      stat.n++
      stat.sum += duration
      if (duration > stat.max) stat.max = duration
      if (span.err) stat.err++
    }
  }

  let active = 0
  for (const turn of timeline.turns) active += turn.e - turn.s
  const waitOnly = unionLength(wait)
  const toolAndWait = unionLength([...wait, ...tool])
  const all = unionLength([...wait, ...tool, ...model])
  const wall = timeline.end - timeline.start

  return {
    wall,
    active,
    idle: Math.max(0, wall - active),
    wait: waitOnly,
    tool: toolAndWait - waitOnly,
    model: all - toolAndWait,
    overhead: Math.max(0, active - all),
    cats: [...cats.values()].map(({ spans, ...stat }) => ({ ...stat, busy: unionLength(spans) })),
    tools: [...tools.values()].sort((a, b) => b.sum - a.sum),
    tokensIn,
    tokensOut,
    ttft: ttftCount === 0 ? 0 : ttftSum / ttftCount,
    modelCalls,
    toolCalls,
    errors,
  }
}
