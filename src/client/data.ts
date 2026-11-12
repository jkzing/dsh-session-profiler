/** Timeline loading and polling for one session. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { applyDelta } from '../shared/build.ts'
import {
  DETAIL_ROUTE, TIMELINE_ROUTE,
  type SpanDetail, type SpanDetailResponse, type Timeline, type TimelineResponse,
} from '../shared/types.ts'

export interface TimelineState {
  timeline: Timeline | null
  status: 'loading' | 'ready' | 'missing' | 'error'
  error?: string
  reload(): void
}

async function post<T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as T
}

/** While a turn runs the timeline grows every second or two; an idle session only needs a heartbeat. */
const POLL_RUNNING_MS = 1500
const POLL_LIVE_MS = 4000
const POLL_COLD_MS = 10_000

export function useTimeline(sessionId: string | undefined): TimelineState {
  const [state, setState] = useState<Omit<TimelineState, 'reload'>>({ timeline: null, status: 'loading' })
  const [generation, setGeneration] = useState(0)
  const reload = useCallback(() => { setGeneration(value => value + 1) }, [])
  const held = useRef<Timeline | null>(null)

  useEffect(() => {
    held.current = null
    setState({ timeline: null, status: 'loading' })
    if (sessionId === undefined || sessionId === '') return
    const abort = new AbortController()
    let timer = 0
    let stopped = false

    const schedule = (delay: number): void => {
      if (stopped) return
      timer = window.setTimeout(() => { void tick() }, delay)
    }
    const tick = async (): Promise<void> => {
      if (stopped) return
      // A hidden tab keeps its timeline; it catches up on the first poll after it is shown again.
      if (document.hidden) {
        schedule(POLL_LIVE_MS)
        return
      }
      const current = held.current
      try {
        const response = await post<TimelineResponse>(
          TIMELINE_ROUTE,
          current === null ? { sessionId } : { sessionId, since: current.cursor },
          abort.signal,
        )
        if (stopped) return
        if (!response.ok) throw new Error(response.error.message)
        let next = current
        if (response.mode === 'full') next = response.timeline
        else if (response.mode === 'delta' && current !== null) next = applyDelta(current, response.delta)
        else if (response.mode === 'unchanged' && current !== null
          && (current.live !== response.live || current.running !== response.running)) {
          next = { ...current, live: response.live, running: response.running }
        } else if (response.mode === 'missing') {
          held.current = null
          setState({ timeline: null, status: 'missing' })
          schedule(POLL_COLD_MS)
          return
        }
        if (next !== null && next !== current) {
          held.current = next
          setState({ timeline: next, status: 'ready' })
        } else if (next !== null) {
          setState(previous => (previous.status === 'ready' ? previous : { timeline: next, status: 'ready' }))
        }
        schedule(next?.running ? POLL_RUNNING_MS : next?.live ? POLL_LIVE_MS : POLL_COLD_MS)
      } catch (error) {
        if (stopped || abort.signal.aborted) return
        // Keep showing what we have; only an empty view turns into an error screen.
        if (held.current === null) {
          setState({ timeline: null, status: 'error', error: error instanceof Error ? error.message : String(error) })
        }
        schedule(POLL_COLD_MS)
      }
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
      abort.abort()
    }
  }, [sessionId, generation])

  return { ...state, reload }
}

export interface DetailState {
  detail: SpanDetail | null
  status: 'loading' | 'ready' | 'error'
}

/** Arguments and result of one span, fetched when it is selected. */
export function useSpanDetail(sessionId: string | undefined, seq: number | undefined, version: number): DetailState {
  const [state, setState] = useState<DetailState>({ detail: null, status: 'loading' })
  useEffect(() => {
    if (sessionId === undefined || seq === undefined) return
    const abort = new AbortController()
    setState(previous => (previous.detail?.seq === seq ? previous : { detail: null, status: 'loading' }))
    post<SpanDetailResponse>(DETAIL_ROUTE, { sessionId, seq }, abort.signal).then((response) => {
      if (abort.signal.aborted) return
      setState(response.ok ? { detail: response.detail, status: 'ready' } : { detail: null, status: 'error' })
    }, () => {
      if (!abort.signal.aborted) setState({ detail: null, status: 'error' })
    })
    return () => { abort.abort() }
    // `version` re-fetches a span that changed (a running call that has now returned).
  }, [sessionId, seq, version])
  return state
}
