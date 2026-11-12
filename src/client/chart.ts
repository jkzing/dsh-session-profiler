/**
 * The timeline chart: one canvas that draws the overview strip, the time axis,
 * the turn and phase rows and the lanes (category tracks or flame bands), and
 * owns zooming, panning, hovering and selection. No React in here; the
 * view component drives it through `setTimeline` / `setOptions`.
 */
import type { Timeline, TimelinePhase, TimelineSpan, TimelineStep, TimelineTurn } from '../shared/types.ts'
import { fmtClock, fmtDate, fmtDur, fmtDurLong, sameDay } from './format.ts'
import type { Translate } from './i18n.ts'
import { flameLanes, laneOrder, trackLanes, type Lane } from './layout.ts'
import { colorOf, ERROR_COLOR, PHASE_RAMP, SEGMENT_COLOR } from './palette.ts'
import { makeScale, tickStep, ticksIn, type Gap, type TimeScale } from './timescale.ts'

export interface ChartTheme {
  bg: string
  /** Slightly raised surface: row bands, the overview strip. */
  raised: string
  text: string
  text2: string
  text3: string
  border: string
  accent: string
  dark: boolean
}

export interface ChartOptions {
  view: 'tracks' | 'flame'
  fold: boolean
  showBackground: boolean
  hidden: ReadonlySet<string>
  query: string
}

export type Hit =
  | { type: 'span'; span: TimelineSpan }
  | { type: 'turn'; turn: TimelineTurn }
  | { type: 'phase'; phase: TimelinePhase; index: number }
  | { type: 'step'; step: TimelineStep }
  | { type: 'gap'; gap: Gap }

export interface ChartCallbacks {
  onSelect(span: TimelineSpan | null): void
  onMatches(count: number): void
}

interface HitBox {
  x: number
  y: number
  w: number
  h: number
  hit: Hit
}

interface LaneBox {
  lane: Lane
  /** Top, relative to the scrollable lane region. */
  y: number
  h: number
}

type MiniZone = 'left' | 'right' | 'inside' | 'outside'

const GUTTER = 172
const PAD_R = 12
/** The overview strip sits on top: a ruler row for the whole timeline, then the activity bars. */
const MINI_TOP = 10
const MINI_RULER_H = 14
const MINI_H = 54
const MINI_BOTTOM = MINI_TOP + MINI_H
const HANDLE_W = 9
const HANDLE_H = 18
/** How far apart the handles stay from the middle of a window too narrow to hold them. */
const HANDLE_APART = HANDLE_W / 2 + 4
const AXIS_Y = MINI_BOTTOM + 8
const AXIS_H = 26
const AXIS_BOTTOM = AXIS_Y + AXIS_H
const TURN_Y = AXIS_BOTTOM + 4
const TURN_H = 22
const PHASE_Y = TURN_Y + TURN_H + 5
const PHASE_H = 40
const HEADER_H = PHASE_Y + PHASE_H + 8
const ROW_H = 16
const ROW_GAP = 3
const LANE_PAD = 8
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
const BAR_TEXT = '#0b1020'

function withAlpha(hex: string, alpha: number): string {
  const value = hex.startsWith('#') && hex.length === 7 ? hex : '#64748b'
  const r = Number.parseInt(value.slice(1, 3), 16)
  const g = Number.parseInt(value.slice(3, 5), 16)
  const b = Number.parseInt(value.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/** Approximate advance width; exact measuring per span would dominate a frame. */
function textWidth(text: string, size: number): number {
  let width = 0
  for (let i = 0; i < text.length; i++) width += text.charCodeAt(i) > 0x2e7f ? size : size * 0.56
  return width
}

function fit(text: string, maxWidth: number, size: number): string {
  if (maxWidth <= size) return ''
  if (textWidth(text, size) <= maxWidth) return text
  let width = size * 0.9
  let end = 0
  for (; end < text.length; end++) {
    width += text.charCodeAt(end) > 0x2e7f ? size : size * 0.56
    if (width > maxWidth) break
  }
  return end <= 0 ? '' : text.slice(0, end) + '…'
}

export class TimelineChart {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly tip: HTMLDivElement
  private readonly resizer: ResizeObserver
  private width = 0
  private height = 0
  private frame = 0

  private timeline: Timeline | null = null
  private colors: Record<string, string> = {}
  private scale: TimeScale | null = null
  private lanes: LaneBox[] = []
  private contentH = 0
  private options: ChartOptions = { view: 'tracks', fold: true, showBackground: true, hidden: new Set(), query: '' }
  private matched: Set<number> | null = null
  private mini: { buckets: Float32Array; cats: string[]; max: number; n: number } | null = null

  private vLeft = 0
  private vRight = 1
  private scrollY = 0
  /** The window tracks the whole timeline until the user zooms or pans. */
  private fitted = true

  private hits: HitBox[] = []
  private hover: Hit | null = null
  private pointerX = -1
  private pointerY = -1
  private selected: number | null = null
  /** What the pointer is over on the overview strip, if it is there at all. */
  private miniHover: MiniZone | null = null
  /**
   * `mini` moves the window along the overview, `left` / `right` drag one of
   * its edges. `grab` keeps the pointer's offset from what it took hold of.
   */
  private drag: { mode: 'pan' | 'mini' | 'left' | 'right'; x: number; y: number; vLeft: number; scrollY: number; moved: boolean; grab: number } | null = null
  private readonly patterns = new Map<string, CanvasPattern | null>()

  private readonly host: HTMLElement
  private theme: ChartTheme
  private t: Translate
  private readonly callbacks: ChartCallbacks

  constructor(host: HTMLElement, theme: ChartTheme, t: Translate, callbacks: ChartCallbacks) {
    this.host = host
    this.theme = theme
    this.t = t
    this.callbacks = callbacks
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'dst-canvas'
    this.canvas.tabIndex = 0
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) throw new Error('dsh-session-timeline: 2d canvas is unavailable')
    this.ctx = ctx
    this.tip = document.createElement('div')
    this.tip.className = 'dst-tip'
    this.tip.hidden = true
    host.append(this.canvas, this.tip)

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('pointercancel', this.onPointerUp)
    this.canvas.addEventListener('pointerleave', this.onPointerLeave)
    this.canvas.addEventListener('dblclick', this.onDoubleClick)
    this.canvas.addEventListener('keydown', this.onKeyDown)
    this.resizer = new ResizeObserver(() => { this.resize() })
    this.resizer.observe(host)
    this.resize()
  }

  destroy(): void {
    cancelAnimationFrame(this.frame)
    this.resizer.disconnect()
    this.canvas.remove()
    this.tip.remove()
  }

  setTheme(theme: ChartTheme): void {
    this.theme = theme
    this.patterns.clear()
    this.invalidate()
  }

  setTranslate(t: Translate): void {
    this.t = t
    this.invalidate()
  }

  setTimeline(timeline: Timeline | null, colors: Record<string, string>): void {
    const scale = this.scale
    const window = scale === null ? null : [scale.toT(this.vLeft), scale.toT(this.vRight)] as const
    this.timeline = timeline
    this.colors = colors
    this.rebuild()
    if (this.fitted || window === null || this.scale === null) this.fitWindow()
    else this.setWindow(this.scale.toV(window[0]), this.scale.toV(window[1]))
    if (this.selected !== null && timeline?.spans.every(span => span.id !== this.selected)) this.selected = null
    this.invalidate()
  }

  setOptions(options: ChartOptions): void {
    const previous = this.options
    const scale = this.scale
    const window = scale === null ? null : [scale.toT(this.vLeft), scale.toT(this.vRight)] as const
    this.options = options
    this.rebuild()
    if (previous.fold !== options.fold) {
      if (this.fitted || window === null || this.scale === null) this.fitWindow()
      else this.setWindow(this.scale.toV(window[0]), this.scale.toV(window[1]))
    }
    this.invalidate()
  }

  setSelected(id: number | null): void {
    this.selected = id
    this.invalidate()
  }

  zoomBy(factor: number): void {
    this.zoomAt(GUTTER + this.plotW / 2, factor)
  }

  fit(): void {
    this.fitWindow()
    this.scrollY = 0
    this.invalidate()
  }

  /** Bring a span into view with some context around it, and scroll its lane in. */
  focusSpan(span: TimelineSpan): void {
    this.focusRange(span.s, span.e)
    const lanesH = this.lanesH
    for (const box of this.lanes) {
      if (!box.lane.spans.includes(span)) continue
      if (box.y < this.scrollY || box.y + box.h > this.scrollY + lanesH) {
        this.scrollY = Math.max(0, Math.min(box.y - 8, this.contentH - lanesH))
      }
    }
    this.invalidate()
  }

  focusRange(start: number, end: number): void {
    if (this.scale === null) return
    const v0 = this.scale.toV(start)
    const v1 = this.scale.toV(end)
    const pad = Math.max((v1 - v0) * 0.35, 150)
    this.fitted = false
    this.setWindow(v0 - pad, v1 + pad)
    this.invalidate()
  }

  // ── geometry ────────────────────────────────────────────────────────────

  private get plotW(): number {
    return Math.max(1, this.width - GUTTER - PAD_R)
  }

  private get lanesTop(): number {
    return HEADER_H
  }

  private get lanesH(): number {
    return Math.max(0, this.height - HEADER_H)
  }

  /** The narrowest window, in virtual ms: two pixels per millisecond at most. */
  private get minSpan(): number {
    return Math.max(this.plotW * 0.5, 20)
  }

  private x(v: number): number {
    return GUTTER + ((v - this.vLeft) / (this.vRight - this.vLeft)) * this.plotW
  }

  private vAt(x: number): number {
    return this.vLeft + ((x - GUTTER) / this.plotW) * (this.vRight - this.vLeft)
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect()
    const width = Math.floor(rect.width)
    const height = Math.floor(rect.height)
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.max(1, Math.round(width * dpr))
    this.canvas.height = Math.max(1, Math.round(height * dpr))
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.mini = null
    this.clampScroll()
    this.invalidate()
  }

  private rebuild(): void {
    const timeline = this.timeline
    this.mini = null
    if (timeline === null) {
      this.scale = null
      this.lanes = []
      this.contentH = 0
      this.matched = null
      return
    }
    this.scale = makeScale(timeline, this.options.fold)
    const laneOptions = { showBackground: this.options.showBackground, hidden: this.options.hidden }
    const lanes = this.options.view === 'flame' ? flameLanes(timeline, laneOptions) : trackLanes(timeline, laneOptions)
    let y = 0
    this.lanes = []
    if (this.options.view === 'flame') {
      const stepLane: Lane = { id: 'steps', spans: [], rows: [], rowCount: 1, count: timeline.steps.length }
      this.lanes.push({ lane: stepLane, y, h: ROW_H + LANE_PAD * 2 })
      y += ROW_H + LANE_PAD * 2
    }
    for (const lane of lanes) {
      const h = LANE_PAD * 2 + lane.rowCount * ROW_H + (lane.rowCount - 1) * ROW_GAP
      this.lanes.push({ lane, y, h })
      y += h
    }
    this.contentH = y
    this.clampScroll()

    const query = this.options.query.trim().toLowerCase()
    if (query === '') {
      this.matched = null
      this.callbacks.onMatches(-1)
    } else {
      const matched = new Set<number>()
      for (const span of timeline.spans) {
        if (span.name.toLowerCase().includes(query) || span.label.toLowerCase().includes(query)) matched.add(span.id)
      }
      this.matched = matched
      this.callbacks.onMatches(matched.size)
    }
  }

  private fitWindow(): void {
    const length = this.scale?.length ?? 1
    this.fitted = true
    this.vLeft = 0
    this.vRight = Math.max(length, 1)
  }

  private setWindow(left: number, right: number): void {
    const length = Math.max(this.scale?.length ?? 1, 1)
    let span = Math.min(Math.max(right - left, this.minSpan), length)
    if (span >= length) {
      this.vLeft = 0
      this.vRight = length
      return
    }
    let l = left
    if (right - left < span) l = (left + right) / 2 - span / 2
    else span = right - left
    l = Math.max(0, Math.min(l, length - span))
    this.vLeft = l
    this.vRight = l + span
  }

  /** Move one edge of the window and leave the other where it is. */
  private resizeWindow(edge: 'left' | 'right', v: number): void {
    const length = Math.max(this.scale?.length ?? 1, 1)
    const minSpan = Math.min(this.minSpan, length)
    if (edge === 'left') this.vLeft = Math.max(0, Math.min(v, this.vRight - minSpan))
    else this.vRight = Math.min(length, Math.max(v, this.vLeft + minSpan))
    this.fitted = this.vLeft <= 0 && this.vRight >= length
  }

  private zoomAt(x: number, factor: number): void {
    this.zoomAround(this.vAt(Math.max(GUTTER, Math.min(x, GUTTER + this.plotW))), factor)
  }

  private zoomAround(v: number, factor: number): void {
    if (this.scale === null) return
    const width = this.vRight - this.vLeft
    // From the overview the pointer can be outside the window; zoom about its middle then.
    const anchor = v < this.vLeft || v > this.vRight ? this.vLeft + width / 2 : v
    const span = width / factor
    const ratio = (anchor - this.vLeft) / width
    this.fitted = false
    this.setWindow(anchor - span * ratio, anchor + span * (1 - ratio))
    if (this.vLeft <= 0 && this.vRight >= this.scale.length) this.fitted = true
    this.invalidate()
  }

  private clampScroll(): void {
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.contentH - this.lanesH))
  }

  private invalidate(): void {
    if (this.frame !== 0) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
    })
  }

  // ── interaction ─────────────────────────────────────────────────────────

  private local(event: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (this.scale === null) return
    event.preventDefault()
    const { x, y } = this.local(event)
    // Over the lane labels the wheel scrolls the lanes; over the plot it zooms time.
    if (x < GUTTER && y > this.lanesTop && this.contentH > this.lanesH) {
      this.scrollY += event.deltaY * (event.deltaMode === 1 ? 32 : 1)
      this.clampScroll()
      this.invalidate()
      return
    }
    // On the overview strip a pixel is a slice of the whole timeline, not of the window.
    const overMini = y < AXIS_Y
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
    if (horizontal || event.shiftKey) {
      const delta = horizontal ? event.deltaX : event.deltaY
      const shift = (delta / this.plotW) * (overMini ? this.scale.length : this.vRight - this.vLeft)
      this.fitted = false
      this.setWindow(this.vLeft + shift, this.vRight + shift)
      this.invalidate()
      return
    }
    const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 32 : 1) * 0.0022)
    if (overMini) this.zoomAround(this.miniV(x), factor)
    else this.zoomAt(x, factor)
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.scale === null) return
    const { x, y } = this.local(event)
    this.canvas.setPointerCapture(event.pointerId)
    this.hideTip()
    const zone = this.miniZone(x, y)
    if (zone === 'left' || zone === 'right') {
      const { x0, x1 } = this.miniWindow()
      this.drag = { mode: zone, x, y, vLeft: this.vLeft, scrollY: this.scrollY, moved: false, grab: (zone === 'left' ? x0 : x1) - x }
      this.invalidate()
      return
    }
    if (zone !== null) {
      const inside = zone === 'inside'
      const span = this.vRight - this.vLeft
      const v = this.miniV(x)
      const grab = inside ? v - this.vLeft : span / 2
      this.drag = { mode: 'mini', x, y, vLeft: this.vLeft, scrollY: this.scrollY, moved: !inside, grab }
      if (!inside) {
        this.fitted = false
        this.setWindow(v - grab, v - grab + span)
      }
      this.updateCursor(x, y)
      this.invalidate()
      return
    }
    this.drag = { mode: 'pan', x, y, vLeft: this.vLeft, scrollY: this.scrollY, moved: false, grab: 0 }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const { x, y } = this.local(event)
    this.pointerX = x
    this.pointerY = y
    const drag = this.drag
    if (drag !== null) {
      const dx = x - drag.x
      const dy = y - drag.y
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
      drag.moved = true
      const span = this.vRight - this.vLeft
      if (drag.mode === 'left' || drag.mode === 'right') {
        this.resizeWindow(drag.mode, this.miniV(x + drag.grab))
      } else if (drag.mode === 'mini') {
        const v = this.miniV(x)
        this.fitted = false
        this.setWindow(v - drag.grab, v - drag.grab + span)
      } else {
        const left = drag.vLeft - (dx / this.plotW) * span
        if (span < (this.scale?.length ?? 0)) {
          this.fitted = false
          this.setWindow(left, left + span)
        }
        this.scrollY = drag.scrollY - dy
        this.clampScroll()
        this.canvas.style.cursor = 'grabbing'
      }
      this.invalidate()
      return
    }
    const hit = this.updateCursor(x, y)
    this.showTip(hit, x, y)
    this.invalidate()
  }

  /** Refresh what the pointer is over, and the cursor that says what a press would do there. */
  private updateCursor(x: number, y: number): Hit | null {
    const zone = this.miniZone(x, y)
    const hit = zone === null ? this.hitAt(x, y) : null
    this.miniHover = zone
    this.hover = hit
    let cursor = hit === null ? 'default' : 'pointer'
    if (zone === 'left' || zone === 'right') cursor = 'ew-resize'
    else if (zone === 'outside') cursor = 'pointer'
    else if (zone === 'inside' && !this.fitted) cursor = this.drag === null ? 'grab' : 'grabbing'
    this.canvas.style.cursor = cursor
    return hit
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag
    this.drag = null
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId)
    const { x, y } = this.local(event)
    const hit = this.updateCursor(x, y)
    this.invalidate()
    if (drag === null || drag.moved || drag.mode !== 'pan') return
    if (hit?.type === 'span') {
      this.selected = hit.span.id
      this.callbacks.onSelect(hit.span)
    } else if (hit === null && this.selected !== null) {
      this.selected = null
      this.callbacks.onSelect(null)
    }
    this.invalidate()
  }

  private readonly onPointerLeave = (): void => {
    if (this.drag !== null) return
    this.pointerX = -1
    this.pointerY = -1
    this.hover = null
    this.miniHover = null
    this.hideTip()
    this.invalidate()
  }

  private readonly onDoubleClick = (event: MouseEvent): void => {
    const { x, y } = this.local(event)
    const hit = this.hitAt(x, y)
    if (hit === null) return
    if (hit.type === 'span') this.focusRange(hit.span.s, hit.span.e)
    else if (hit.type === 'turn') this.focusRange(hit.turn.s, hit.turn.e)
    else if (hit.type === 'phase') this.focusRange(hit.phase.s, hit.phase.e)
    else if (hit.type === 'step') this.focusRange(hit.step.s, hit.step.e)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const span = this.vRight - this.vLeft
    switch (event.key) {
      case '+':
      case '=':
        this.zoomBy(1.5)
        break
      case '-':
      case '_':
        this.zoomBy(1 / 1.5)
        break
      case '0':
        this.fit()
        break
      case 'ArrowLeft':
      case 'ArrowRight': {
        const shift = span * 0.15 * (event.key === 'ArrowLeft' ? -1 : 1)
        this.fitted = false
        this.setWindow(this.vLeft + shift, this.vRight + shift)
        this.invalidate()
        break
      }
      case 'Escape':
        if (this.selected === null) return
        this.selected = null
        this.callbacks.onSelect(null)
        this.invalidate()
        break
      default:
        return
    }
    event.preventDefault()
  }

  private hitAt(x: number, y: number): Hit | null {
    if (x < GUTTER || y < AXIS_Y) return null
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const box = this.hits[i] as HitBox
      if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return box.hit
    }
    return null
  }

  private miniV(x: number): number {
    const length = this.scale?.length ?? 1
    return Math.max(0, Math.min(1, (x - GUTTER) / this.plotW)) * length
  }

  /**
   * The window on the overview strip: its edges, and the centre of each
   * handle. A handle sits on its edge until the window gets too narrow to
   * hold both; from there they stay put either side of it, so there is always
   * a handle to take and a middle to move the window by.
   */
  private miniWindow(): { x0: number; x1: number; left: number; right: number } {
    const length = Math.max(this.scale?.length ?? 1, 1)
    const x0 = GUTTER + (this.vLeft / length) * this.plotW
    const x1 = GUTTER + (this.vRight / length) * this.plotW
    const mid = (x0 + x1) / 2
    return { x0, x1, left: Math.min(x0, mid - HANDLE_APART), right: Math.max(x1, mid + HANDLE_APART) }
  }

  private miniZone(x: number, y: number): MiniZone | null {
    if (this.scale === null || y < MINI_TOP - 6 || y > MINI_BOTTOM + 3) return null
    if (x < GUTTER - HANDLE_W - 3 || x > GUTTER + this.plotW + HANDLE_W + 3) return null
    const { left, right } = this.miniWindow()
    // A little more reach outwards than inwards, where the window itself is the target.
    const outer = HANDLE_W / 2 + 4
    const inner = HANDLE_W / 2 + 1
    if (x >= left - outer && x <= left + inner) return 'left'
    if (x >= right - inner && x <= right + outer) return 'right'
    return x > left && x < right ? 'inside' : 'outside'
  }

  // ── tooltip ─────────────────────────────────────────────────────────────

  private hideTip(): void {
    this.tip.hidden = true
  }

  private showTip(hit: Hit | null, x: number, y: number): void {
    if (hit === null) {
      this.hideTip()
      return
    }
    const tip = this.tip
    tip.replaceChildren()
    const line = (className: string, text: string): void => {
      if (text === '') return
      const row = document.createElement('div')
      row.className = className
      row.textContent = text
      tip.append(row)
    }
    const t = this.t
    const range = (s: number, e: number): string => `${fmtClock(s)} → ${fmtClock(e)}  ·  ${fmtDurLong(e - s)}`
    if (hit.type === 'span') {
      const span = hit.span
      const head = document.createElement('div')
      head.className = 'dst-tip-head'
      const dot = document.createElement('i')
      dot.style.background = colorOf(this.colors, span.cat)
      const name = document.createElement('b')
      name.textContent = span.name
      const kind = document.createElement('span')
      kind.textContent = `${t(`kind.${span.kind}`)} · ${this.categoryLabel(span.cat)}`
      head.append(dot, name, kind)
      tip.append(head)
      line('dst-tip-label', span.label)
      line('dst-tip-time', range(span.s, span.e))
      if (span.segs !== undefined) {
        line('dst-tip-meta', span.segs.map(seg => `${t(`seg.${seg.k}`)} ${fmtDur(seg.e - seg.s)}`).join(' · '))
      }
      if (span.tok !== undefined) line('dst-tip-meta', t('detail.tokensValue', { in: span.tok.in, out: span.tok.out }))
      const state = span.err ? t('state.error') : span.run ? t('state.running') : span.open ? t('state.open') : ''
      if (state !== '') line(span.err ? 'dst-tip-state dst-bad' : 'dst-tip-state', state)
    } else if (hit.type === 'turn') {
      const turn = hit.turn
      line('dst-tip-title', `${t('turn', { n: turn.turn })}${turn.reason !== undefined && turn.reason !== 'completed' ? ` · ${turn.reason}` : ''}`)
      line('dst-tip-label', turn.label)
      line('dst-tip-time', range(turn.s, turn.e))
      line('dst-tip-meta', t('turn.steps', { n: turn.steps }))
    } else if (hit.type === 'phase') {
      line('dst-tip-title', this.phaseLabel(hit.phase))
      line('dst-tip-time', range(hit.phase.s, hit.phase.e))
    } else if (hit.type === 'step') {
      line('dst-tip-title', `${t('turn', { n: hit.step.turn })} · ${t('step', { n: hit.step.step })}`)
      line('dst-tip-time', range(hit.step.s, hit.step.e))
    } else {
      line('dst-tip-title', t('idle', { d: fmtDurLong(hit.gap.t1 - hit.gap.t0) }))
      line('dst-tip-time', `${fmtDate(hit.gap.t0)} ${fmtClock(hit.gap.t0)} → ${fmtDate(hit.gap.t1)} ${fmtClock(hit.gap.t1)}`)
    }
    tip.hidden = false
    const tw = tip.offsetWidth
    const th = tip.offsetHeight
    let left = x + 14
    let top = y + 16
    if (left + tw > this.width - 6) left = Math.max(6, x - tw - 12)
    if (top + th > this.height - 6) top = Math.max(6, y - th - 12)
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  }

  private categoryLabel(id: string): string {
    const custom = this.timeline?.categories.find(category => category.id === id)
    return custom?.label ?? this.t(`cat.${id}`)
  }

  private phaseLabel(phase: TimelinePhase): string {
    if (phase.src === 'wrap') return this.t('phase.wrap')
    return phase.label !== '' ? phase.label : this.t('phase.prompt')
  }

  // ── drawing ─────────────────────────────────────────────────────────────

  private hatch(color: string): CanvasPattern | null {
    const cached = this.patterns.get(color)
    if (cached !== undefined) return cached
    const tile = document.createElement('canvas')
    tile.width = 8
    tile.height = 8
    const ctx = tile.getContext('2d')
    let pattern: CanvasPattern | null = null
    if (ctx !== null) {
      ctx.fillStyle = withAlpha(color, this.theme.dark ? 0.3 : 0.25)
      ctx.fillRect(0, 0, 8, 8)
      ctx.strokeStyle = withAlpha(color, this.theme.dark ? 0.85 : 0.9)
      ctx.lineWidth = 1.6
      ctx.beginPath()
      for (const offset of [-8, 0, 8]) {
        ctx.moveTo(offset, 8)
        ctx.lineTo(offset + 8, 0)
      }
      ctx.stroke()
      pattern = this.ctx.createPattern(tile, 'repeat')
    }
    this.patterns.set(color, pattern)
    return pattern
  }

  private draw(): void {
    const { ctx, width, height, theme } = this
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = theme.bg
    ctx.fillRect(0, 0, width, height)
    this.hits = []
    const timeline = this.timeline
    const scale = this.scale
    if (timeline === null || scale === null || width < GUTTER + 40) return

    const plotLeft = GUTTER
    const plotRight = GUTTER + this.plotW
    const ppv = this.plotW / (this.vRight - this.vLeft)
    const step = tickStep(ppv, 108)
    const ticks = ticksIn(scale, this.vLeft, this.vRight, step)
    const lanesTop = this.lanesTop
    const lanesH = this.lanesH

    // Lanes (scrollable region).
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, lanesTop, width, lanesH)
    ctx.clip()
    for (const box of this.lanes) {
      const top = lanesTop + box.y - this.scrollY
      if (top > lanesTop + lanesH || top + box.h < lanesTop) continue
      ctx.fillStyle = theme.border
      ctx.fillRect(0, Math.round(top + box.h) - 1, width, 1)
    }
    ctx.fillStyle = withAlphaOf(theme.text3, 0.1)
    for (const tick of ticks) ctx.fillRect(Math.round(this.x(tick.v)), lanesTop, 1, lanesH)
    this.drawGaps(scale, lanesTop, lanesH, true)
    ctx.save()
    ctx.beginPath()
    ctx.rect(plotLeft, lanesTop, this.plotW + PAD_R, lanesH)
    ctx.clip()
    for (const box of this.lanes) {
      const top = lanesTop + box.y - this.scrollY
      if (top > lanesTop + lanesH || top + box.h < lanesTop) continue
      if (box.lane.id === 'steps') this.drawSteps(timeline, top + LANE_PAD)
      else this.drawLane(box.lane, top + LANE_PAD, plotLeft, plotRight)
    }
    ctx.restore()
    // Lane labels.
    ctx.fillStyle = theme.bg
    ctx.fillRect(0, lanesTop, GUTTER - 1, lanesH)
    for (const box of this.lanes) {
      const top = lanesTop + box.y - this.scrollY
      if (top > lanesTop + lanesH || top + box.h < lanesTop) continue
      ctx.fillStyle = theme.border
      ctx.fillRect(0, Math.round(top + box.h) - 1, GUTTER, 1)
      this.drawLaneLabel(box, top)
    }
    ctx.restore()
    if (this.contentH > lanesH + 1) {
      const track = lanesH - 8
      const thumb = Math.max(24, (lanesH / this.contentH) * track)
      const offset = (this.scrollY / (this.contentH - lanesH)) * (track - thumb)
      ctx.fillStyle = withAlphaOf(theme.text3, 0.45)
      this.roundRect(width - 7, lanesTop + 4 + offset, 4, thumb, 2)
      ctx.fill()
    }

    // Header: overview, axis, turns, phases.
    ctx.fillStyle = theme.bg
    ctx.fillRect(0, 0, width, HEADER_H)
    this.drawGaps(scale, AXIS_BOTTOM, HEADER_H - AXIS_BOTTOM, false)
    this.drawAxis(ticks, step, plotLeft, plotRight)
    ctx.save()
    ctx.beginPath()
    ctx.rect(plotLeft, AXIS_Y, this.plotW + PAD_R, HEADER_H - AXIS_Y)
    ctx.clip()
    this.drawTurns(timeline)
    this.drawPhases(timeline)
    ctx.restore()
    ctx.fillStyle = theme.text3
    ctx.font = `11px ${FONT}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillText(this.t('row.turns'), 16, TURN_Y + TURN_H / 2)
    ctx.fillStyle = theme.text
    ctx.font = `600 12px ${FONT}`
    ctx.fillText(this.t('row.phases'), 16, PHASE_Y + PHASE_H / 2)
    ctx.fillStyle = theme.text3
    ctx.font = `11px ${MONO}`
    ctx.textAlign = 'right'
    ctx.fillText(String(timeline.phases.length), GUTTER - 14, PHASE_Y + PHASE_H / 2)
    ctx.textAlign = 'left'
    ctx.fillStyle = theme.border
    ctx.fillRect(0, HEADER_H - 1, width, 1)
    ctx.fillRect(0, AXIS_Y - 1, width, 1)
    ctx.fillRect(GUTTER - 1, AXIS_BOTTOM, 1, height - AXIS_BOTTOM)

    this.drawCursor(scale, plotLeft, plotRight)
    this.drawMini(timeline, scale)
  }

  private drawAxis(ticks: { v: number; t: number }[], step: number, plotLeft: number, plotRight: number): void {
    const { ctx, theme } = this
    ctx.font = `11px ${MONO}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    let previous: number | null = null
    let lastRight = -Infinity
    for (const tick of ticks) {
      const x = this.x(tick.v)
      if (x < plotLeft - 1 || x > plotRight + 1) continue
      ctx.fillStyle = withAlphaOf(theme.text3, 0.5)
      ctx.fillRect(Math.round(x), AXIS_BOTTOM - 5, 1, 5)
      const dated = previous === null ? !sameDay(tick.t, Date.now()) && ticks[0] === tick : !sameDay(previous, tick.t)
      const label = dated ? `${fmtDate(tick.t)} ${fmtClock(tick.t, step)}` : fmtClock(tick.t, step)
      previous = tick.t
      const w = textWidth(label, 11) + 10
      const left = Math.max(plotLeft, Math.min(x - w / 2, plotRight - w))
      if (left < lastRight) continue
      lastRight = left + w
      ctx.fillStyle = theme.text2
      ctx.fillText(label, left + w / 2, AXIS_Y + AXIS_H / 2 - 1)
    }
    ctx.textAlign = 'left'
  }

  /** Folded idle stretches: a hatched band, labelled along its length when it is wide enough. */
  private drawGaps(scale: TimeScale, top: number, h: number, labelled: boolean): void {
    const { ctx, theme } = this
    for (const gap of scale.gaps) {
      const x0 = this.x(gap.v0)
      const x1 = this.x(gap.v1)
      if (x1 < GUTTER || x0 > this.width) continue
      const w = Math.max(2, x1 - x0)
      ctx.fillStyle = withAlphaOf(theme.text3, theme.dark ? 0.09 : 0.07)
      ctx.fillRect(x0, top, w, h)
      ctx.fillStyle = withAlphaOf(theme.text3, 0.28)
      ctx.fillRect(Math.round(x0), top, 1, h)
      ctx.fillRect(Math.round(x0 + w) - 1, top, 1, h)
      if (!labelled) continue
      this.hits.push({ x: x0, y: top, w, h, hit: { type: 'gap', gap } })
      if (w < 12 || h < 70) continue
      const label = this.t('idle', { d: fmtDur(gap.t1 - gap.t0) })
      ctx.save()
      ctx.translate(x0 + w / 2, top + Math.min(h / 2, 120))
      ctx.rotate(-Math.PI / 2)
      ctx.fillStyle = theme.text3
      ctx.font = `10px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, 0, 0.5)
      ctx.restore()
    }
  }

  private drawTurns(timeline: Timeline): void {
    const { ctx, theme, scale } = this
    if (scale === null) return
    ctx.font = `11px ${FONT}`
    ctx.textBaseline = 'middle'
    for (const turn of timeline.turns) {
      const x0 = this.x(scale.toV(turn.s))
      const x1 = this.x(scale.toV(turn.e))
      if (x1 < GUTTER - 2 || x0 > this.width) continue
      const w = Math.max(3, x1 - x0 - 1)
      const failed = turn.reason !== undefined && turn.reason !== 'completed'
      ctx.fillStyle = withAlphaOf(theme.text3, theme.dark ? 0.14 : 0.1)
      ctx.fillRect(x0, TURN_Y, w, TURN_H)
      ctx.fillStyle = failed ? ERROR_COLOR : withAlphaOf(theme.text2, 0.75)
      ctx.fillRect(x0, TURN_Y, 2, TURN_H)
      const text = `${this.t('turn', { n: turn.turn })} · ${fmtDur(turn.e - turn.s)}${turn.label === '' ? '' : `   ${turn.label}`}`
      const visibleLeft = Math.max(x0, GUTTER)
      const label = fit(text, x0 + w - visibleLeft - 14, 11)
      if (label !== '') {
        ctx.fillStyle = theme.text2
        ctx.fillText(label, visibleLeft + 9, TURN_Y + TURN_H / 2 + 0.5)
      }
      this.hits.push({ x: x0, y: TURN_Y, w, h: TURN_H, hit: { type: 'turn', turn } })
    }
  }

  private drawPhases(timeline: Timeline): void {
    const { ctx, scale } = this
    if (scale === null) return
    timeline.phases.forEach((phase, index) => {
      const x0 = this.x(scale.toV(phase.s))
      const x1 = this.x(scale.toV(phase.e))
      if (x1 < GUTTER - 2 || x0 > this.width) return
      const w = Math.max(2, x1 - x0 - 1)
      const color = PHASE_RAMP[index % PHASE_RAMP.length] as string
      ctx.fillStyle = color
      this.roundRect(x0, PHASE_Y, w, PHASE_H, 3)
      ctx.fill()
      const visibleLeft = Math.max(x0, GUTTER)
      const room = x0 + w - visibleLeft - 14
      const title = fit(this.phaseLabel(phase), room, 12)
      if (title !== '') {
        ctx.fillStyle = BAR_TEXT
        ctx.font = `600 12px ${FONT}`
        ctx.textBaseline = 'middle'
        ctx.fillText(title, visibleLeft + 8, PHASE_Y + 13)
        const sub = fit(`${fmtClock(phase.s)} · ${fmtDur(phase.e - phase.s)}`, room, 10.5)
        if (sub !== '') {
          ctx.fillStyle = 'rgba(11,16,32,0.72)'
          ctx.font = `10.5px ${MONO}`
          ctx.fillText(sub, visibleLeft + 8, PHASE_Y + 28.5)
        }
      }
      this.hits.push({ x: x0, y: PHASE_Y, w, h: PHASE_H, hit: { type: 'phase', phase, index } })
    })
  }

  private drawSteps(timeline: Timeline, top: number): void {
    const { ctx, theme, scale } = this
    if (scale === null) return
    ctx.font = `10.5px ${MONO}`
    ctx.textBaseline = 'middle'
    for (const step of timeline.steps) {
      const x0 = this.x(scale.toV(step.s))
      const x1 = this.x(scale.toV(step.e))
      if (x1 < GUTTER - 2 || x0 > this.width) continue
      const w = Math.max(1.5, x1 - x0 - 1)
      ctx.fillStyle = withAlphaOf(theme.text3, step.step % 2 === 1 ? 0.3 : 0.2)
      ctx.fillRect(x0, top, w, ROW_H)
      if (w > 34) {
        const label = fit(`${step.turn}.${step.step}  ${fmtDur(step.e - step.s)}`, w - 8, 10.5)
        ctx.fillStyle = theme.text2
        ctx.fillText(label, Math.max(x0, GUTTER) + 4, top + ROW_H / 2 + 0.5)
      }
      this.hits.push({ x: x0, y: top, w, h: ROW_H, hit: { type: 'step', step } })
    }
  }

  private drawLane(lane: Lane, top: number, plotLeft: number, plotRight: number): void {
    const { ctx, theme, scale } = this
    if (scale === null) return
    const matched = this.matched
    for (let i = 0; i < lane.spans.length; i++) {
      const span = lane.spans[i] as TimelineSpan
      const x0 = this.x(scale.toV(span.s))
      const x1 = this.x(scale.toV(span.e))
      if (x1 < plotLeft - 2 || x0 > plotRight + PAD_R) continue
      const y = top + (lane.rows[i] as number) * (ROW_H + ROW_GAP)
      const w = Math.max(2, x1 - x0)
      const color = colorOf(this.colors, span.cat)
      const dim = matched !== null && !matched.has(span.id)
      ctx.globalAlpha = dim ? 0.16 : 1

      if (span.kind === 'job') {
        ctx.fillStyle = this.hatch(color) ?? withAlpha(color, 0.4)
        ctx.fillRect(x0, y, w, ROW_H)
        ctx.strokeStyle = withAlpha(color, 0.9)
        ctx.lineWidth = 1
        ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(1, w - 1), ROW_H - 1)
      } else if (span.kind === 'model' && span.segs !== undefined && w >= 5) {
        ctx.fillStyle = withAlpha(color, theme.dark ? 0.3 : 0.25)
        this.roundRect(x0, y, w, ROW_H, 2)
        ctx.fill()
        for (const seg of span.segs) {
          const s0 = this.x(scale.toV(seg.s))
          const s1 = this.x(scale.toV(seg.e))
          ctx.fillStyle = seg.k === 'wait' ? withAlpha(SEGMENT_COLOR.wait, theme.dark ? 0.95 : 0.35) : SEGMENT_COLOR[seg.k]
          ctx.fillRect(s0, y, Math.max(0.5, s1 - s0), ROW_H)
        }
      } else if (span.open && !span.run) {
        ctx.fillStyle = withAlpha(color, 0.28)
        ctx.fillRect(x0, y, w, ROW_H)
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        ctx.setLineDash([3, 2])
        ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(1, w - 1), ROW_H - 1)
        ctx.setLineDash([])
      } else {
        ctx.fillStyle = span.run ? withAlpha(color, 0.72) : color
        if (w > 5) {
          this.roundRect(x0, y, w, ROW_H, 2)
          ctx.fill()
        } else {
          ctx.fillRect(x0, y, w, ROW_H)
        }
      }
      if (span.err) {
        ctx.strokeStyle = ERROR_COLOR
        ctx.lineWidth = 1.5
        ctx.strokeRect(x0 - 0.25, y - 0.25, w + 0.5, ROW_H + 0.5)
      }
      if (w >= 34) {
        const visibleLeft = Math.max(x0, plotLeft)
        const room = x0 + w - visibleLeft - 8
        const text = span.kind === 'job'
          ? fit(`${fmtDur(span.e - span.s)}  ${span.label}`, room, 10.5)
          : fit(span.kind === 'model' ? `${fmtDur(span.e - span.s)}  ${span.label}` : (span.label || span.name), room, 10.5)
        if (text !== '') {
          ctx.font = `10.5px ${span.kind === 'job' ? MONO : FONT}`
          ctx.textBaseline = 'middle'
          ctx.fillStyle = span.kind === 'job' || (span.open && !span.run) ? theme.text : BAR_TEXT
          if (span.kind === 'model') ctx.fillStyle = theme.dark ? '#eef2ff' : BAR_TEXT
          ctx.fillText(text, visibleLeft + 5, y + ROW_H / 2 + 0.5)
        }
      }
      if (span.id === this.selected) {
        ctx.globalAlpha = 1
        ctx.strokeStyle = theme.text
        ctx.lineWidth = 1.5
        ctx.strokeRect(x0 - 1.25, y - 1.25, w + 2.5, ROW_H + 2.5)
      }
      // Narrow spans get a wider target so they can still be hovered.
      const pad = w < 6 ? (6 - w) / 2 : 0
      if (!dim) this.hits.push({ x: x0 - pad, y, w: w + pad * 2, h: ROW_H, hit: { type: 'span', span } })
    }
    ctx.globalAlpha = 1
  }

  private drawLaneLabel(box: LaneBox, top: number): void {
    const { ctx, theme } = this
    const lane = box.lane
    const flame = lane.id === 'steps' || lane.id.startsWith('depth')
    const cy = top + Math.min(box.h / 2, LANE_PAD + ROW_H / 2 + 6)
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    if (!flame) {
      ctx.fillStyle = colorOf(this.colors, lane.id)
      this.roundRect(16, cy - 5, 10, 10, 2.5)
      ctx.fill()
    }
    ctx.fillStyle = theme.text
    ctx.font = `12px ${FONT}`
    const label = flame ? this.t(`row.${lane.id}`) : this.categoryLabel(lane.id)
    const count = String(lane.count)
    const left = flame ? 16 : 34
    ctx.fillText(fit(label, GUTTER - left - 22 - textWidth(count, 11), 12), left, cy + 0.5)
    ctx.fillStyle = theme.text3
    ctx.font = `11px ${MONO}`
    ctx.textAlign = 'right'
    ctx.fillText(count, GUTTER - 14, cy + 0.5)
    ctx.textAlign = 'left'
  }

  private drawCursor(scale: TimeScale, plotLeft: number, plotRight: number): void {
    const { ctx, theme } = this
    const x = this.pointerX
    if (this.drag !== null || x < plotLeft || x > plotRight || this.pointerY < AXIS_Y) return
    ctx.fillStyle = withAlphaOf(theme.text2, 0.45)
    ctx.fillRect(Math.round(x), AXIS_BOTTOM, 1, this.height - AXIS_BOTTOM)
    const ppv = this.plotW / (this.vRight - this.vLeft)
    const label = fmtClock(scale.toT(this.vAt(x)), ppv > 0.05 ? 1 : 1000)
    const w = textWidth(label, 11) + 12
    const left = Math.max(plotLeft, Math.min(x - w / 2, plotRight - w))
    ctx.fillStyle = theme.accent
    this.roundRect(left, AXIS_Y + 4, w, AXIS_H - 8, 4)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = `11px ${MONO}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, left + w / 2, AXIS_Y + AXIS_H / 2)
    ctx.textAlign = 'left'
  }

  /**
   * Overview strip: how busy each lane was across the whole timeline, under a
   * ruler of its own, with the visible window and its two handles on top.
   */
  private drawMini(timeline: Timeline, scale: TimeScale): void {
    const { ctx, theme } = this
    const top = MINI_TOP
    const left = GUTTER
    const w = this.plotW
    ctx.fillStyle = theme.text3
    ctx.font = `11px ${FONT}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillText(this.t('row.overview'), 16, top + MINI_H / 2)
    ctx.fillStyle = theme.raised
    this.roundRect(left, top, w, MINI_H, 4)
    ctx.fill()

    // Ruler: the whole timeline, however far the chart below is zoomed in.
    const step = tickStep(w / scale.length, 96)
    ctx.font = `10px ${MONO}`
    let previous: number | null = null
    let lastRight = -Infinity
    for (const tick of ticksIn(scale, 0, scale.length, step)) {
      const x = Math.round(left + (tick.v / scale.length) * w)
      if (x < left + 2 || x > left + w - 2) continue
      ctx.fillStyle = withAlphaOf(theme.text3, 0.22)
      ctx.fillRect(x, top, 1, MINI_H)
      const label = previous !== null && !sameDay(previous, tick.t) ? `${fmtDate(tick.t)} ${fmtClock(tick.t, step)}` : fmtClock(tick.t, step)
      const right = x + 5 + textWidth(label, 10)
      if (x < lastRight + 8 || right > left + w - 4) continue
      previous = tick.t
      lastRight = right
      ctx.fillStyle = theme.text3
      ctx.fillText(label, x + 5, top + MINI_RULER_H / 2 + 1.5)
    }

    const n = Math.max(1, Math.floor(w / 3))
    if (this.mini === null || this.mini.n !== n) this.mini = this.miniBuckets(timeline, scale, n)
    const { buckets, cats, max } = this.mini
    const k = cats.length
    if (max > 0) {
      const usable = MINI_H - MINI_RULER_H - 5
      for (let b = 0; b < n; b++) {
        let y = top + MINI_H - 2
        for (let c = 0; c < k; c++) {
          const value = buckets[b * k + c] as number
          if (value <= 0) continue
          const h = Math.max(1, (value / max) * usable)
          ctx.fillStyle = colorOf(this.colors, cats[c] as string)
          ctx.fillRect(left + b * 3, y - h, 2, h)
          y -= h
        }
      }
    }
    ctx.fillStyle = withAlphaOf(theme.text3, 0.5)
    for (const gap of scale.gaps) {
      ctx.fillRect(Math.round(left + ((gap.v0 + gap.v1) / 2 / scale.length) * w), top + MINI_RULER_H + 1, 1, MINI_H - MINI_RULER_H - 3)
    }
    const { x0, x1, left: handleL, right: handleR } = this.miniWindow()
    ctx.fillStyle = withAlphaOf(theme.bg, 0.55)
    ctx.fillRect(left, top, Math.max(0, x0 - left), MINI_H)
    ctx.fillRect(x1, top, Math.max(0, left + w - x1), MINI_H)
    ctx.strokeStyle = theme.accent
    ctx.lineWidth = 1.5
    const boxW = Math.max(3, x1 - x0 - 1.5)
    this.roundRect(Math.min(x0 + 0.75, (x0 + x1 - boxW) / 2), top + 0.75, boxW, MINI_H - 1.5, 4)
    ctx.stroke()
    const held = this.drag?.mode
    this.drawHandle(handleL, held === 'left' || (held === undefined && this.miniHover === 'left'))
    this.drawHandle(handleR, held === 'right' || (held === undefined && this.miniHover === 'right'))
  }

  /** A grip on one edge of the overview window, lit while the pointer is on it. */
  private drawHandle(centre: number, active: boolean): void {
    const { ctx, theme } = this
    const x = Math.round(centre - HANDLE_W / 2)
    const y = MINI_TOP - 4
    if (active) {
      ctx.fillStyle = withAlphaOf(theme.accent, 0.32)
      this.roundRect(x - 3, y - 3, HANDLE_W + 6, HANDLE_H + 6, 6)
      ctx.fill()
    }
    // A rim in the background colour keeps the grip apart from the bars behind it.
    ctx.fillStyle = theme.bg
    this.roundRect(x - 1, y - 1, HANDLE_W + 2, HANDLE_H + 2, 4)
    ctx.fill()
    ctx.fillStyle = theme.accent
    this.roundRect(x, y, HANDLE_W, HANDLE_H, 3)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    ctx.fillRect(x + 3, y + 5, 1, HANDLE_H - 10)
    ctx.fillRect(x + HANDLE_W - 4, y + 5, 1, HANDLE_H - 10)
  }

  private miniBuckets(timeline: Timeline, scale: TimeScale, n: number): { buckets: Float32Array; cats: string[]; max: number; n: number } {
    const cats = laneOrder(timeline).filter(id => !this.options.hidden.has(id))
    const index = new Map(cats.map((id, i) => [id, i]))
    const k = cats.length
    const buckets = new Float32Array(n * Math.max(1, k))
    const size = scale.length / n
    for (const span of timeline.spans) {
      const c = index.get(span.cat)
      if (c === undefined) continue
      if (span.kind === 'job' && !this.options.showBackground) continue
      const v0 = scale.toV(span.s)
      const v1 = Math.max(scale.toV(span.e), v0 + size * 0.15)
      const b0 = Math.max(0, Math.floor(v0 / size))
      const b1 = Math.min(n - 1, Math.floor(v1 / size))
      for (let b = b0; b <= b1; b++) {
        const overlap = Math.min(v1, (b + 1) * size) - Math.max(v0, b * size)
        if (overlap > 0) buckets[b * k + c] = (buckets[b * k + c] as number) + overlap / size
      }
    }
    let max = 0
    for (let b = 0; b < n; b++) {
      let total = 0
      for (let c = 0; c < k; c++) total += buckets[b * k + c] as number
      if (total > max) max = total
    }
    return { buckets, cats, max, n }
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx
    const radius = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, radius)
    else ctx.rect(x, y, w, h)
  }
}

/** Alpha over a resolved theme color, which arrives as `rgb(…)` / `rgba(…)` or hex. */
function withAlphaOf(color: string, alpha: number): string {
  if (color.startsWith('#')) return withAlpha(color.length === 7 ? color : '#64748b', alpha)
  const parts = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(color)
  if (parts === null) return color
  const own = parts[4] === undefined ? 1 : (parts[4].endsWith('%') ? Number.parseFloat(parts[4]) / 100 : Number.parseFloat(parts[4]))
  return `rgba(${parts[1]},${parts[2]},${parts[3]},${(own * alpha).toFixed(3)})`
}
