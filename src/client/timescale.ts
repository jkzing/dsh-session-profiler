/**
 * Real time ↔ the chart's horizontal domain.
 *
 * A session is a few bursts of work separated by the user being away. Drawn
 * on a wall-clock axis the bursts shrink to slivers, so by default the idle
 * stretches between turns are folded to a fixed narrow band. The domain is
 * "virtual milliseconds": inside an active segment one virtual ms is one real
 * ms, and a folded gap is `gapWidth` virtual ms wide whatever its real length.
 */
import type { Trace } from '../shared/types.ts'

export interface Segment {
  /** Real start/end. */
  t0: number
  t1: number
  /** Virtual start. */
  v0: number
}

export interface Gap {
  t0: number
  t1: number
  v0: number
  v1: number
}

export interface TimeScale {
  /** Virtual length of the whole trace. */
  length: number
  segments: Segment[]
  gaps: Gap[]
  /** Real ms → virtual ms. */
  toV(time: number): number
  /** Virtual ms → real ms. */
  toT(v: number): number
}

/** Idle stretches shorter than this stay on the axis as they are. */
export const MIN_FOLD_MS = 60_000

type Interval = [number, number]

/** Merged intervals in which the session was doing something. */
export function activeIntervals(trace: Trace): Interval[] {
  const raw: Interval[] = trace.turns.map(turn => [turn.s, turn.e])
  for (const span of trace.spans) {
    // Background processes and subagents run across idle time; they must not unfold it.
    if (span.kind === 'job' || span.kind === 'agent') continue
    raw.push([span.s, span.e])
  }
  raw.sort((a, b) => a[0] - b[0])
  const merged: Interval[] = []
  for (const [s, e] of raw) {
    const last = merged[merged.length - 1]
    if (last !== undefined && s <= last[1]) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }
  return merged
}

export function makeScale(trace: Trace, fold: boolean): TimeScale {
  const start = trace.start
  const end = Math.max(trace.end, start + 1)
  let intervals: Interval[] = fold ? activeIntervals(trace) : []
  if (intervals.length === 0) intervals = [[start, end]]
  // Stretch the first and last interval to the trace bounds so every time maps somewhere.
  ;(intervals[0] as Interval)[0] = Math.min((intervals[0] as Interval)[0], start)
  ;(intervals[intervals.length - 1] as Interval)[1] = Math.max((intervals[intervals.length - 1] as Interval)[1], end)

  // Fold only gaps long enough to matter; join the rest back into one segment.
  const joined: Interval[] = []
  for (const interval of intervals) {
    const last = joined[joined.length - 1]
    if (last !== undefined && interval[0] - last[1] < MIN_FOLD_MS) last[1] = Math.max(last[1], interval[1])
    else joined.push([interval[0], interval[1]])
  }
  let active = 0
  for (const [s, e] of joined) active += e - s
  const gapWidth = Math.max(active * 0.014, 400)

  const segments: Segment[] = []
  const gaps: Gap[] = []
  // Breakpoints of the piecewise-linear map, as parallel arrays.
  const ts: number[] = []
  const vs: number[] = []
  let v = 0
  joined.forEach(([s, e], index) => {
    if (index > 0) {
      const prev = joined[index - 1] as Interval
      gaps.push({ t0: prev[1], t1: s, v0: v, v1: v + gapWidth })
      v += gapWidth
    }
    segments.push({ t0: s, t1: e, v0: v })
    ts.push(s, e)
    vs.push(v, v + (e - s))
    v += e - s
  })
  const length = v

  const interpolate = (x: number, xs: number[], ys: number[]): number => {
    const n = xs.length
    if (x <= (xs[0] as number)) return (ys[0] as number) + (x - (xs[0] as number))
    if (x >= (xs[n - 1] as number)) return (ys[n - 1] as number) + (x - (xs[n - 1] as number))
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if ((xs[mid] as number) <= x) lo = mid
      else hi = mid
    }
    const x0 = xs[lo] as number
    const x1 = xs[hi] as number
    const y0 = ys[lo] as number
    const y1 = ys[hi] as number
    return x1 === x0 ? y0 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)
  }

  return {
    length,
    segments,
    gaps,
    toV: time => interpolate(time, ts, vs),
    toT: virtual => interpolate(virtual, vs, ts),
  }
}

const STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  1000, 2000, 5000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
]

/** Smallest round step that keeps ticks at least `minPx` apart. */
export function tickStep(pxPerMs: number, minPx: number): number {
  for (const step of STEPS) {
    if (step * pxPerMs >= minPx) return step
  }
  return STEPS[STEPS.length - 1] as number
}

export interface Tick {
  v: number
  t: number
}

/**
 * Round wall-clock ticks inside the visible window. Ticks are generated per
 * active segment, so a folded gap never carries one.
 */
export function ticksIn(scale: TimeScale, vLeft: number, vRight: number, step: number): Tick[] {
  const ticks: Tick[] = []
  const zone = new Date(scale.toT(vLeft)).getTimezoneOffset() * 60_000
  for (const segment of scale.segments) {
    const v1 = segment.v0 + (segment.t1 - segment.t0)
    if (v1 < vLeft || segment.v0 > vRight) continue
    const from = Math.max(segment.t0, scale.toT(vLeft))
    const to = Math.min(segment.t1, scale.toT(vRight))
    // Align in local time so an hourly tick lands on the hour.
    let t = Math.ceil((from - zone) / step) * step + zone
    for (; t <= to && ticks.length < 400; t += step) ticks.push({ v: segment.v0 + (t - segment.t0), t })
  }
  return ticks
}
