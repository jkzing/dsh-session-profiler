/** Lane model: which spans go in which lane, and on which row inside it. */
import { BUILTIN_CATEGORIES, type Timeline, type TimelineSpan } from '../shared/types.ts'

export interface Lane {
  /** Category id, or a flame band id. */
  id: string
  spans: TimelineSpan[]
  /** Row of `spans[i]` inside the lane. */
  rows: number[]
  rowCount: number
  /** Calls in the lane, not counting background processes. */
  count: number
}

/**
 * Greedy interval packing: each span takes the first row that is free at its
 * start. Past `maxRows` it shares the row that frees up soonest, so a lane
 * never grows without bound.
 * @param spans - spans sorted by start.
 */
export function packRows(spans: readonly TimelineSpan[], maxRows: number): { rows: number[]; rowCount: number } {
  const ends: number[] = []
  const rows: number[] = []
  for (const span of spans) {
    let row = -1
    for (let i = 0; i < ends.length; i++) {
      if ((ends[i] as number) <= span.s) {
        row = i
        break
      }
    }
    if (row < 0) {
      if (ends.length < maxRows) {
        row = ends.length
        ends.push(span.e)
      } else {
        row = 0
        for (let i = 1; i < ends.length; i++) {
          if ((ends[i] as number) < (ends[row] as number)) row = i
        }
      }
    }
    ends[row] = Math.max(ends[row] ?? 0, span.e)
    rows.push(row)
  }
  return { rows, rowCount: Math.max(1, ends.length) }
}

function byStart(a: TimelineSpan, b: TimelineSpan): number {
  return a.s - b.s || a.id - b.id
}

export interface LaneOptions {
  showBackground: boolean
  hidden: ReadonlySet<string>
}

/** Lane ids in display order: the model, then config-defined lanes, then the other built-ins. */
export function laneOrder(timeline: Timeline): string[] {
  const order: string[] = ['model']
  for (const category of timeline.categories) if (!order.includes(category.id)) order.push(category.id)
  for (const id of BUILTIN_CATEGORIES) if (!order.includes(id)) order.push(id)
  return order
}

/** One lane per category that has calls, each packed into rows. */
export function trackLanes(timeline: Timeline, options: LaneOptions): Lane[] {
  const groups = new Map<string, TimelineSpan[]>()
  const counts = new Map<string, number>()
  for (const span of timeline.spans) {
    if (span.kind !== 'job') counts.set(span.cat, (counts.get(span.cat) ?? 0) + 1)
    if (span.kind === 'job' && !options.showBackground) continue
    let group = groups.get(span.cat)
    if (group === undefined) {
      group = []
      groups.set(span.cat, group)
    }
    group.push(span)
  }
  const order = laneOrder(timeline)
  for (const id of groups.keys()) if (!order.includes(id)) order.push(id)
  const lanes: Lane[] = []
  for (const id of order) {
    const spans = groups.get(id)
    if (spans === undefined || options.hidden.has(id)) continue
    spans.sort(byStart)
    const { rows, rowCount } = packRows(spans, id === 'model' ? 2 : 5)
    lanes.push({ id, spans, rows, rowCount, count: counts.get(id) ?? 0 })
  }
  return lanes
}

/**
 * Flame bands: calls the model made directly, then what those calls
 * dispatched or left running. Steps and turns are drawn above by the chart.
 */
export function flameLanes(timeline: Timeline, options: LaneOptions): Lane[] {
  const depth = new Map<number, number>()
  const bands: TimelineSpan[][] = []
  for (const span of timeline.spans) {
    if (options.hidden.has(span.cat)) continue
    if (span.kind === 'job' && !options.showBackground) continue
    const level = span.parent === undefined ? 0 : Math.min((depth.get(span.parent) ?? 0) + 1, 3)
    depth.set(span.id, level)
    ;(bands[level] ??= []).push(span)
  }
  const lanes: Lane[] = []
  bands.forEach((spans, level) => {
    if (spans === undefined || spans.length === 0) return
    spans.sort(byStart)
    const { rows, rowCount } = packRows(spans, 8)
    lanes.push({ id: `depth${level}`, spans, rows, rowCount, count: spans.filter(s => s.kind !== 'job').length })
  })
  return lanes
}
