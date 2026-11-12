import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fmtDur, fmtDurLong } from '../src/client/format.ts'
import { flameLanes, packRows, trackLanes } from '../src/client/layout.ts'
import { makeScale, tickStep, ticksIn } from '../src/client/timescale.ts'
import type { Timeline, TimelineSpan } from '../src/shared/types.ts'

const HOUR = 3_600_000

function span(id: number, s: number, e: number, extra: Partial<TimelineSpan> = {}): TimelineSpan {
  return { id, kind: 'tool', cat: 'shell', name: 'bash', label: '', s, e, turn: 1, step: 1, seq: id, mod: id, ...extra }
}

function timeline(turns: [number, number][], spans: TimelineSpan[] = []): Timeline {
  return {
    v: 1, sessionId: 's', cursor: 0, live: false, running: false, now: 0,
    start: turns[0]?.[0] ?? 0, end: Math.max(...turns.map(t => t[1]), ...spans.map(s => s.e)),
    spans, steps: [], phases: [], categories: [],
    turns: turns.map(([s, e], i) => ({ turn: i + 1, s, e, label: '', steps: 0 })),
  }
}

test('folding collapses long idle gaps and stays invertible', () => {
  const t = timeline([[0, 10 * 60_000], [5 * HOUR, 5 * HOUR + 20 * 60_000]])
  const folded = makeScale(t, true)
  assert.equal(folded.segments.length, 2)
  assert.equal(folded.gaps.length, 1)
  const active = 30 * 60_000
  assert.ok(folded.length < active * 1.05, 'the gap costs a few percent of the width')
  for (const time of [0, 60_000, 10 * 60_000, 2 * HOUR, 5 * HOUR, 5 * HOUR + 60_000, t.end]) {
    assert.ok(Math.abs(folded.toT(folded.toV(time)) - time) < 1e-6, `round trip at ${time}`)
  }
  assert.equal(folded.toV(60_000), 60_000)
  // Inside an active segment one virtual ms is one real ms.
  assert.equal(folded.toV(5 * HOUR + 60_000) - folded.toV(5 * HOUR), 60_000)

  const flat = makeScale(t, false)
  assert.equal(flat.gaps.length, 0)
  assert.equal(flat.length, t.end - t.start)
  assert.equal(flat.toV(2 * HOUR), 2 * HOUR)
})

test('short gaps are not folded, and background spans do not unfold idle time', () => {
  const short = makeScale(timeline([[0, 60_000], [90_000, 150_000]]), true)
  assert.equal(short.gaps.length, 0)
  const background = makeScale(timeline([[0, 60_000], [HOUR, HOUR + 60_000]], [span(1, 30_000, HOUR + 30_000, { kind: 'job', bg: true })]), true)
  assert.equal(background.gaps.length, 1)
})

test('ticks land on round local times and skip folded gaps', () => {
  const base = new Date(2026, 0, 5, 16, 0, 0).getTime()
  const t = timeline([[base + 7 * 60_000, base + 50 * 60_000], [base + 6 * HOUR, base + 6 * HOUR + 30 * 60_000]])
  const scale = makeScale(t, true)
  const step = tickStep(900 / scale.length, 100)
  assert.equal(step, 10 * 60_000)
  const ticks = ticksIn(scale, 0, scale.length, step)
  assert.ok(ticks.length >= 6)
  for (const tick of ticks) {
    assert.equal(new Date(tick.t).getMinutes() % 10, 0)
    assert.equal(new Date(tick.t).getSeconds(), 0)
    assert.ok(scale.gaps.every(gap => tick.t <= gap.t0 || tick.t >= gap.t1))
  }
})

test('row packing separates overlaps and caps the row count', () => {
  const spans = [span(0, 0, 10), span(1, 5, 15), span(2, 10, 20), span(3, 12, 30), span(4, 13, 14)]
  assert.deepEqual(packRows(spans, 5), { rows: [0, 1, 0, 2, 3], rowCount: 4 })
  assert.equal(packRows(spans, 2).rowCount, 2)
})

test('lanes: ordered by category, background processes optional', () => {
  const t = timeline([[0, 100]], [
    span(0, 0, 10, { cat: 'read' }),
    span(1, 0, 50, { cat: 'model', kind: 'model' }),
    span(2, 20, 90, { cat: 'build', kind: 'job', bg: true, parent: 3 }),
    span(3, 20, 25, { cat: 'build' }),
  ])
  const all = trackLanes(t, { showBackground: true, hidden: new Set() })
  assert.deepEqual(all.map(l => [l.id, l.spans.length, l.count]), [['model', 1, 1], ['build', 2, 1], ['read', 1, 1]])
  const some = trackLanes(t, { showBackground: false, hidden: new Set(['read']) })
  assert.deepEqual(some.map(l => [l.id, l.spans.length]), [['model', 1], ['build', 1]])
  const flame = flameLanes(t, { showBackground: true, hidden: new Set() })
  assert.deepEqual(flame.map(l => [l.id, l.spans.map(s => s.id)]), [['depth0', [0, 1, 3]], ['depth1', [2]]])
})

test('durations', () => {
  assert.deepEqual([850, 12_300, 22 * 60_000, 3.4 * HOUR, 50 * HOUR].map(fmtDur), ['850ms', '12s', '22m', '3.4h', '2.1d'])
  assert.deepEqual([850, 12_340, 200_000, 3_720_000].map(fmtDurLong), ['850 ms', '12.34 s', '3m 20s', '1h 02m'])
})
