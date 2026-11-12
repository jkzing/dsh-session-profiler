/**
 * The timeline tab: toolbar, timing summary, legend, the chart (tracks or
 * flame) or the statistics tables, and the detail panel for the selected span.
 */
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { summarize, type TimelineStats } from '../shared/stats.ts'
import type { Timeline, TimelineSpan } from '../shared/types.ts'
import { TimelineChart, type ChartOptions } from './chart.ts'
import { useSpanDetail, useTimeline } from './data.ts'
import { fmtClock, fmtCount, fmtDate, fmtDur, fmtDurLong, fmtPct } from './format.ts'
import type { Translate } from './i18n.ts'
import { laneOrder } from './layout.ts'
import { colorOf, colorsFor, SEGMENT_COLOR } from './palette.ts'
import { readTheme, watchTheme } from './theme.ts'

export interface TimelineViewProps {
  sessionId?: string
  t: Translate
}

type ViewMode = 'tracks' | 'flame' | 'stats'

const PREFS_KEY = 'dsh-session-timeline:prefs'

interface Prefs {
  view: ViewMode
  fold: boolean
  showBackground: boolean
}

function loadPrefs(): Prefs {
  const prefs: Prefs = { view: 'tracks', fold: true, showBackground: true }
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>
    if (stored.view === 'tracks' || stored.view === 'flame' || stored.view === 'stats') prefs.view = stored.view
    if (typeof stored.fold === 'boolean') prefs.fold = stored.fold
    if (typeof stored.showBackground === 'boolean') prefs.showBackground = stored.showBackground
  } catch {
    // Storage can be blocked; the defaults stand.
  }
  return prefs
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Not being able to remember a toggle is not worth surfacing.
  }
}

function categoryLabel(timeline: Timeline, t: Translate, id: string): string {
  return timeline.categories.find(category => category.id === id)?.label ?? t(`cat.${id}`)
}

function Button(props: { onClick(): void; active?: boolean; title?: string; children?: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      className={props.active ? 'dst-btn dst-on' : 'dst-btn'}
      aria-pressed={props.active}
      title={props.title}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function Summary(props: { stats: TimelineStats; timeline: Timeline; t: Translate }): ReactNode {
  const { stats, t } = props
  const parts = [
    { key: 'model', value: stats.model, color: '#5b8def' },
    { key: 'tool', value: stats.tool, color: '#f59e42' },
    { key: 'wait', value: stats.wait, color: '#d6b98c' },
    { key: 'overhead', value: stats.overhead, color: '#64748b' },
  ].filter(part => part.value > 0)
  return (
    <div className="dst-summary">
      <div className="dst-stat dst-stat-main">
        <b>{fmtDurLong(stats.active)}</b>
        <span>{t('stat.active')}</span>
      </div>
      <div className="dst-split">
        <div className="dst-split-bar">
          {parts.map(part => (
            <i
              key={part.key}
              style={{ flexGrow: part.value, background: part.color }}
              title={`${t(`stat.${part.key}`)} ${fmtDurLong(part.value)}`}
            />
          ))}
        </div>
        <div className="dst-split-keys">
          {parts.map(part => (
            <span key={part.key}>
              <i style={{ background: part.color }} />
              {t(`stat.${part.key}`)}
              <b>{fmtDur(part.value)}</b>
              <em>{fmtPct(part.value, stats.active)}</em>
            </span>
          ))}
        </div>
      </div>
      <div className="dst-stat">
        <b>{fmtDur(stats.wall)}</b>
        <span>{t('stat.wall')}</span>
      </div>
      <div className="dst-stat">
        <b>{fmtDur(stats.idle)}</b>
        <span>{t('stat.idle')}</span>
      </div>
      <div className="dst-stat">
        <b>{stats.ttft > 0 ? fmtDur(stats.ttft) : '–'}</b>
        <span>{t('stat.ttft')}</span>
      </div>
      <div className="dst-stat">
        <b>{fmtCount(stats.tokensIn)} / {fmtCount(stats.tokensOut)}</b>
        <span>{t('stat.tokens')}</span>
      </div>
      <div className="dst-stat dst-stat-wide">
        <b>{t('stat.calls', { m: stats.modelCalls, t: stats.toolCalls })}</b>
        <span className={stats.errors > 0 ? 'dst-bad' : undefined}>{t('stat.errors', { n: stats.errors })}</span>
      </div>
    </div>
  )
}

function Legend(props: {
  timeline: Timeline
  stats: TimelineStats
  colors: Record<string, string>
  hidden: ReadonlySet<string>
  onToggle(id: string): void
  t: Translate
}): ReactNode {
  const { timeline, stats, colors, hidden, t } = props
  const counts = new Map(stats.cats.map(cat => [cat.cat, cat.n]))
  const ids = laneOrder(timeline).filter(id => counts.has(id))
  return (
    <div className="dst-legend">
      {ids.map(id => (
        <button
          type="button"
          key={id}
          className={hidden.has(id) ? 'dst-chip dst-off' : 'dst-chip'}
          aria-pressed={!hidden.has(id)}
          onClick={() => { props.onToggle(id) }}
        >
          <i style={{ background: colorOf(colors, id) }} />
          {categoryLabel(timeline, t, id)}
          <em>{counts.get(id)}</em>
        </button>
      ))}
      <span className="dst-legend-note">{t('legend.note')}</span>
    </div>
  )
}

function Bar(props: { value: number; max: number; color: string }): ReactNode {
  const width = props.max <= 0 ? 0 : Math.max(1, Math.min(100, (props.value / props.max) * 100))
  return <span className="dst-bar"><i style={{ width: `${width}%`, background: props.color }} /></span>
}

function StatsTables(props: {
  timeline: Timeline
  stats: TimelineStats
  colors: Record<string, string>
  onPick(span: TimelineSpan): void
  t: Translate
}): ReactNode {
  const { timeline, stats, colors, t } = props
  const cats = useMemo(() => {
    const order = laneOrder(timeline)
    return stats.cats.filter(cat => cat.n > 0).sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat))
  }, [timeline, stats])
  const maxBusy = Math.max(1, ...cats.map(cat => cat.busy))
  const tools = stats.tools.slice(0, 16)
  const maxTool = Math.max(1, ...tools.map(tool => tool.sum))
  const slowest = useMemo(
    () => timeline.spans.filter(span => span.kind !== 'job' && span.kind !== 'agent').sort((a, b) => (b.e - b.s) - (a.e - a.s)).slice(0, 20),
    [timeline],
  )
  const maxSlow = Math.max(1, ...slowest.map(span => span.e - span.s))
  return (
    <div className="dst-tables">
      <section>
        <h3>{t('table.byCategory')}</h3>
        <table>
          <thead>
            <tr>
              <th>{t('table.name')}</th>
              <th className="dst-num">{t('table.count')}</th>
              <th className="dst-num">{t('table.busy')}</th>
              <th className="dst-num">{t('table.share')}</th>
              <th />
              <th className="dst-num">{t('table.total')}</th>
              <th className="dst-num">{t('table.avg')}</th>
              <th className="dst-num">{t('table.max')}</th>
              <th className="dst-num">{t('table.errors')}</th>
            </tr>
          </thead>
          <tbody>
            {cats.map(cat => (
              <tr key={cat.cat}>
                <td><i className="dst-dot" style={{ background: colorOf(colors, cat.cat) }} />{categoryLabel(timeline, t, cat.cat)}</td>
                <td className="dst-num">{cat.n}</td>
                <td className="dst-num">{fmtDur(cat.busy)}</td>
                <td className="dst-num">{fmtPct(cat.busy, stats.active)}</td>
                <td className="dst-barcell"><Bar value={cat.busy} max={maxBusy} color={colorOf(colors, cat.cat)} /></td>
                <td className="dst-num">{fmtDur(cat.sum)}</td>
                <td className="dst-num">{fmtDur(cat.sum / cat.n)}</td>
                <td className="dst-num">{fmtDur(cat.max)}</td>
                <td className={cat.err > 0 ? 'dst-num dst-bad' : 'dst-num'}>{cat.err}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h3>{t('table.byTool')}</h3>
        <table>
          <thead>
            <tr>
              <th>{t('table.name')}</th>
              <th className="dst-num">{t('table.count')}</th>
              <th className="dst-num">{t('table.total')}</th>
              <th />
              <th className="dst-num">{t('table.avg')}</th>
              <th className="dst-num">{t('table.max')}</th>
              <th className="dst-num">{t('table.errors')}</th>
            </tr>
          </thead>
          <tbody>
            {tools.map(tool => (
              <tr key={tool.name}>
                <td><i className="dst-dot" style={{ background: colorOf(colors, tool.cat) }} /><code>{tool.name}</code></td>
                <td className="dst-num">{tool.n}</td>
                <td className="dst-num">{fmtDur(tool.sum)}</td>
                <td className="dst-barcell"><Bar value={tool.sum} max={maxTool} color={colorOf(colors, tool.cat)} /></td>
                <td className="dst-num">{fmtDur(tool.sum / tool.n)}</td>
                <td className="dst-num">{fmtDur(tool.max)}</td>
                <td className={tool.err > 0 ? 'dst-num dst-bad' : 'dst-num'}>{tool.err}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="dst-tables-wide">
        <h3>{t('table.slowest')}</h3>
        <table>
          <thead>
            <tr>
              <th className="dst-num">{t('detail.duration')}</th>
              <th />
              <th>{t('table.name')}</th>
              <th>{t('detail.where')}</th>
              <th className="dst-num">{t('table.when')}</th>
            </tr>
          </thead>
          <tbody>
            {slowest.map(span => (
              <tr key={span.id} className="dst-row-link" onClick={() => { props.onPick(span) }}>
                <td className="dst-num">{fmtDur(span.e - span.s)}</td>
                <td className="dst-barcell"><Bar value={span.e - span.s} max={maxSlow} color={colorOf(colors, span.cat)} /></td>
                <td className="dst-ellipsis">
                  <i className="dst-dot" style={{ background: colorOf(colors, span.cat) }} />
                  <code>{span.name}</code>
                  <span className="dst-muted">{span.label}</span>
                </td>
                <td className="dst-muted">{t('detail.whereValue', { turn: span.turn, step: span.step })}</td>
                <td className="dst-num dst-muted">{fmtClock(span.s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}

function Block(props: { title: string; text: string; bad?: boolean }): ReactNode {
  return (
    <Fragment>
      <h4>{props.title}</h4>
      <pre className={props.bad ? 'dst-pre dst-bad' : 'dst-pre'}>{props.text}</pre>
    </Fragment>
  )
}

function Detail(props: {
  span: TimelineSpan
  timeline: Timeline
  colors: Record<string, string>
  onClose(): void
  onFocus(): void
  t: Translate
}): ReactNode {
  const { span, timeline, colors, t } = props
  const { detail, status } = useSpanDetail(timeline.sessionId, span.seq, span.mod)
  const duration = span.e - span.s
  const state = span.err ? 'error' : span.run ? 'running' : span.open ? 'open' : 'ok'
  const generation = span.segs?.filter(seg => seg.k !== 'wait').reduce((sum, seg) => sum + (seg.e - seg.s), 0) ?? 0
  const speed = span.tok !== undefined && generation > 0 ? (span.tok.out / generation) * 1000 : 0
  const empty = detail === null
    || (detail.args === undefined && detail.result === undefined && detail.text === undefined
      && detail.reasoning === undefined && detail.calls === undefined)
  return (
    <aside className="dst-detail">
      <header>
        <i className="dst-dot" style={{ background: colorOf(colors, span.cat) }} />
        <b>{span.name}</b>
        <span className="dst-muted">{t(`kind.${span.kind}`)}</span>
        <span className="dst-spacer" />
        <button type="button" className="dst-btn dst-btn-small" onClick={props.onFocus}>{t('detail.focus')}</button>
        <button type="button" className="dst-btn dst-btn-small" aria-label={t('detail.close')} onClick={props.onClose}>✕</button>
      </header>
      <div className="dst-detail-body">
        {span.label !== '' && <p className="dst-detail-label">{span.label}</p>}
        <dl>
          <dt>{t('detail.duration')}</dt>
          <dd><b>{fmtDurLong(duration)}</b></dd>
          <dt>{t('detail.start')}</dt>
          <dd>{fmtDate(span.s)} {fmtClock(span.s, 1)}</dd>
          <dt>{t('detail.end')}</dt>
          <dd>{fmtDate(span.e)} {fmtClock(span.e, 1)}</dd>
          <dt>{t('detail.where')}</dt>
          <dd>{t('detail.whereValue', { turn: span.turn, step: span.step })} · {categoryLabel(timeline, t, span.cat)}</dd>
          <dt>{t('detail.state')}</dt>
          <dd className={state === 'error' ? 'dst-bad' : undefined}>
            {t(`state.${state}`)}{detail?.errorCode !== undefined ? ` · ${detail.errorCode}` : ''}
          </dd>
          {span.tok !== undefined && (
            <Fragment>
              <dt>{t('detail.tokens')}</dt>
              <dd>{t('detail.tokensValue', { in: fmtCount(span.tok.in), out: fmtCount(span.tok.out) })}</dd>
            </Fragment>
          )}
          {speed > 0 && (
            <Fragment>
              <dt>{t('detail.speed')}</dt>
              <dd>{speed.toFixed(1)} tok/s</dd>
            </Fragment>
          )}
        </dl>
        {span.segs !== undefined && span.segs.length > 0 && (
          <div className="dst-segs">
            <div className="dst-split-bar">
              {span.segs.map((seg, index) => (
                <i key={index} style={{ flexGrow: Math.max(seg.e - seg.s, duration / 200), background: SEGMENT_COLOR[seg.k] }} />
              ))}
            </div>
            <ul>
              {span.segs.map((seg, index) => (
                <li key={index}>
                  <i className="dst-dot" style={{ background: SEGMENT_COLOR[seg.k] }} />
                  {t(`seg.${seg.k}`)}
                  <b>{fmtDurLong(seg.e - seg.s)}</b>
                </li>
              ))}
            </ul>
          </div>
        )}
        {status === 'loading' && <p className="dst-muted">{t('detail.loading')}</p>}
        {status !== 'loading' && empty && <p className="dst-muted">{t('detail.none')}</p>}
        {detail?.calls !== undefined && <Block title={t('detail.calls')} text={detail.calls.join('\n')} />}
        {detail?.args !== undefined && detail.args !== '' && <Block title={t('detail.args')} text={detail.args} />}
        {detail?.reasoning !== undefined && <Block title={t('detail.reasoning')} text={detail.reasoning} />}
        {detail?.text !== undefined && <Block title={t('detail.text')} text={detail.text} />}
        {detail?.result !== undefined && detail.result !== '' && (
          <Block title={t('detail.result')} text={detail.result} bad={detail.isError} />
        )}
        {detail?.truncated === true && <p className="dst-muted">{t('detail.truncated')}</p>}
      </div>
    </aside>
  )
}

export function TimelineView(props: TimelineViewProps): ReactNode {
  const { sessionId, t } = props
  const { timeline, status, error, reload } = useTimeline(sessionId)
  const [prefs, setPrefs] = useState(loadPrefs)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState(-1)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<TimelineChart | null>(null)
  const translate = useRef(t)
  translate.current = t

  const colors = useMemo(() => colorsFor(timeline), [timeline?.categories])
  const stats = useMemo(() => (timeline === null ? null : summarize(timeline)), [timeline])
  const selected = useMemo(
    () => (timeline === null || selectedId === null ? null : timeline.spans.find(span => span.id === selectedId) ?? null),
    [timeline, selectedId],
  )
  const chartView = prefs.view === 'flame' ? 'flame' : 'tracks'
  const options: ChartOptions = useMemo(
    () => ({ view: chartView, fold: prefs.fold, showBackground: prefs.showBackground, hidden, query }),
    [chartView, prefs.fold, prefs.showBackground, hidden, query],
  )
  const hasData = timeline !== null && (timeline.spans.length > 0 || timeline.turns.length > 0)

  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((previous) => {
      const next = { ...previous, ...patch }
      savePrefs(next)
      return next
    })
  }, [])

  // The chart outlives re-renders; it is created once the host element exists.
  useEffect(() => {
    const host = hostRef.current
    const root = rootRef.current
    if (host === null || root === null) return
    const chart = new TimelineChart(host, readTheme(root), (key, params) => translate.current(key, params), {
      onSelect: span => { setSelectedId(span?.id ?? null) },
      onMatches: count => { setMatches(count) },
    })
    chartRef.current = chart
    const stop = watchTheme(() => { chart.setTheme(readTheme(root)) })
    return () => {
      stop()
      chart.destroy()
      chartRef.current = null
    }
  }, [hasData])

  useEffect(() => { chartRef.current?.setOptions(options) }, [options, hasData])
  useEffect(() => { chartRef.current?.setTimeline(timeline, colors) }, [timeline, colors, hasData])
  useEffect(() => { chartRef.current?.setSelected(selectedId) }, [selectedId, hasData])
  useEffect(() => { setSelectedId(null) }, [sessionId])

  const toggleCategory = useCallback((id: string) => {
    setHidden((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const pick = useCallback((span: TimelineSpan) => {
    update({ view: 'tracks' })
    setSelectedId(span.id)
    // The chart host is hidden while the tables show; focus once it has a size again.
    requestAnimationFrame(() => { requestAnimationFrame(() => { chartRef.current?.focusSpan(span) }) })
  }, [update])

  let body: ReactNode
  if (!hasData || timeline === null || stats === null) {
    body = (
      <div className="dst-empty">
        {status === 'loading' && <span>{t('status.loading')}</span>}
        {status === 'missing' && <span>{t('status.missing')}</span>}
        {status === 'ready' && <span>{t('status.empty')}</span>}
        {status === 'error' && (
          <Fragment>
            <span className="dst-bad">{t('status.error', { message: error ?? '' })}</span>
            <Button onClick={reload}>{t('status.retry')}</Button>
          </Fragment>
        )}
      </div>
    )
  } else {
    body = (
      <Fragment>
        <Summary stats={stats} timeline={timeline} t={t} />
        <Legend timeline={timeline} stats={stats} colors={colors} hidden={hidden} onToggle={toggleCategory} t={t} />
        <div className="dst-body">
          <div className="dst-chart" ref={hostRef} hidden={prefs.view === 'stats'} />
          {prefs.view === 'stats' && <StatsTables timeline={timeline} stats={stats} colors={colors} onPick={pick} t={t} />}
          {selected !== null && prefs.view !== 'stats' && (
            <Detail
              span={selected}
              timeline={timeline}
              colors={colors}
              onClose={() => { setSelectedId(null) }}
              onFocus={() => { chartRef.current?.focusSpan(selected) }}
              t={t}
            />
          )}
        </div>
      </Fragment>
    )
  }

  const charting = prefs.view !== 'stats'
  return (
    <div className="dst-root" ref={rootRef}>
      <div className="dst-toolbar">
        <div className="dst-title">
          <b>{t('title')}</b>
          {timeline?.running === true && <span className="dst-live"><i />{t('status.live')}</span>}
          <span className="dst-hint">{t('hint')}</span>
        </div>
        <span className="dst-spacer" />
        {matches >= 0 && charting && <span className="dst-matches">{t('matches', { n: matches })}</span>}
        <input
          className="dst-search"
          type="search"
          value={query}
          placeholder={t('search')}
          disabled={!charting}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <div className="dst-seg" role="tablist">
          {(['tracks', 'flame', 'stats'] as const).map(view => (
            <button
              type="button"
              key={view}
              role="tab"
              aria-selected={prefs.view === view}
              className={prefs.view === view ? 'dst-on' : undefined}
              onClick={() => { update({ view }) }}
            >
              {t(`view.${view}`)}
            </button>
          ))}
        </div>
        {charting && (
          <Fragment>
            <Button onClick={() => { chartRef.current?.zoomBy(1.6) }}>{t('zoomIn')}</Button>
            <Button onClick={() => { chartRef.current?.zoomBy(1 / 1.6) }}>{t('zoomOut')}</Button>
            <Button onClick={() => { chartRef.current?.fit() }}>{t('fit')}</Button>
            <Button active={prefs.showBackground} onClick={() => { update({ showBackground: !prefs.showBackground }) }}>
              {t('background')}
            </Button>
            <Button active={prefs.fold} onClick={() => { update({ fold: !prefs.fold }) }}>{t('fold')}</Button>
          </Fragment>
        )}
      </div>
      {body}
    </div>
  )
}
