/**
 * Host half: two POST routes that fold a session's committed events into a
 * timeline. The plugin holds no subscriptions and writes nothing to the session
 * log; every read goes through `sessionQuery.observeSession`, which serves
 * attached sessions from memory and cold ones from persistence.
 *
 * The host faces are typed locally and probed defensively so the plugin loads
 * across dsh releases without compiling against their packages.
 */
import { buildTimeline, deltaSince, spanDetail, type LogEvent } from '../shared/build.ts'
import { compileRules, type RuleSet } from '../shared/classify.ts'
import {
  DETAIL_ROUTE, TIMELINE_ROUTE,
  type SpanDetailResponse, type Timeline, type TimelineResponse,
} from '../shared/types.ts'

export const name = 'dsh-session-timeline'

export const inject = ['connection']

export interface Config {
  /** Extra lanes: calls whose `"<tool> <label>"` matches go to the first matching category. */
  categories?: { id: string; label?: string; color?: string; match: string }[]
}

interface FetchRoute {
  path: string
  methods: readonly string[]
  requestBody: 'buffered'
  fetch: (request: Request) => Response | Promise<Response>
}

interface ConnectionFace {
  fetch?: { register?(route: FetchRoute): unknown }
}

interface Observation {
  source?: 'live' | 'prepared'
  header?: { id?: string }
  inheritedEventCount?: number
  events?: readonly LogEvent[]
  cursor?: number
  revision?: unknown
}

interface SessionQueryFace {
  observeSession?(id: string, options: { projectionMode: 'none' }): Promise<Observation | null | undefined>
}

interface SessionsFace {
  get?(id: string): unknown
}

interface HostContext {
  get(name: string): unknown
  effect(effect: () => unknown, label?: string): unknown
  logger?: { warn?(...args: unknown[]): void }
}

interface CacheEntry {
  cursor: number
  live: boolean
  revision: unknown
  timeline: Timeline
}

/** Timelines kept between polls; the fold is cheap, so this only spares repeat work on a hot tab. */
const CACHE_MAX = 6
/** A running timeline's open spans end at the build clock; rebuild at most this often while nothing was logged. */
const RUNNING_REFRESH_MS = 1000

function reply(value: TimelineResponse | SpanDetailResponse): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
}

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return body !== null && typeof body === 'object' ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

function release(observation: unknown): void {
  const dispose = (observation as { [Symbol.dispose]?: unknown } | null | undefined)?.[Symbol.dispose]
  if (typeof dispose === 'function') dispose.call(observation)
}

export function apply(ctx: HostContext, config: Config = {}): void {
  const warn = (message: string): void => { ctx.logger?.warn?.(`${name}: ${message}`) }
  const rules: RuleSet = compileRules(config?.categories, warn)
  const cache = new Map<string, CacheEntry>()

  const isLive = (sessionId: string): boolean => {
    const sessions = ctx.get('sessions') as SessionsFace | undefined
    try {
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
      return session !== undefined && session !== null
    } catch {
      return false
    }
  }

  const observe = async (sessionId: string): Promise<Observation | null> => {
    const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
    if (typeof query?.observeSession !== 'function') {
      throw new Error('the sessionQuery service is not available in this profile')
    }
    try {
      return await query.observeSession(sessionId, { projectionMode: 'none' }) ?? null
    } catch (error) {
      // An unknown id is an answer, not a failure.
      if (error instanceof Error && /not found/i.test(error.message)) return null
      throw error
    }
  }

  const remember = (sessionId: string, entry: CacheEntry): void => {
    cache.delete(sessionId)
    cache.set(sessionId, entry)
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  /** The current timeline, or null when the session does not exist. */
  const timelineOf = async (sessionId: string): Promise<Timeline | null> => {
    const observation = await observe(sessionId)
    if (observation === null) return null
    try {
      const live = observation.source === 'live' || (observation.source === undefined && isLive(sessionId))
      const cursor = typeof observation.cursor === 'number' ? observation.cursor : -1
      const now = Date.now()
      const hit = cache.get(sessionId)
      if (hit !== undefined && hit.cursor === cursor && hit.live === live && hit.revision === observation.revision
        && !(hit.timeline.running && now - hit.timeline.now >= RUNNING_REFRESH_MS)) {
        return hit.timeline
      }
      const events = observation.events
      if (!Array.isArray(events)) return null
      const timeline = buildTimeline(events as readonly LogEvent[], {
        sessionId,
        live,
        now,
        rules,
        inherited: typeof observation.inheritedEventCount === 'number' ? observation.inheritedEventCount : 0,
      })
      remember(sessionId, { cursor, live, revision: observation.revision, timeline })
      return timeline
    } finally {
      release(observation)
    }
  }

  const timelineRoute = async (request: Request): Promise<Response> => {
    const body = await bodyOf(request)
    const sessionId = body?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return failure(`${name}/bad-request`, 'missing sessionId')
    const since = typeof body?.since === 'number' && Number.isFinite(body.since) ? body.since : undefined
    try {
      // A cold session cannot change under a client that already holds it: skip the persistence read.
      if (since !== undefined && !isLive(sessionId)) {
        const held = cache.get(sessionId)
        if (held !== undefined && !held.live && held.cursor === since) {
          return reply({ ok: true, mode: 'unchanged', live: false, running: false, now: Date.now() })
        }
      }
      const timeline = await timelineOf(sessionId)
      if (timeline === null) return reply({ ok: true, mode: 'missing' })
      if (since === undefined || since > timeline.cursor) return reply({ ok: true, mode: 'full', timeline })
      if (since === timeline.cursor && !timeline.running) {
        return reply({ ok: true, mode: 'unchanged', live: timeline.live, running: false, now: timeline.now })
      }
      return reply({ ok: true, mode: 'delta', delta: deltaSince(timeline, since) })
    } catch (error) {
      return failure(`${name}/internal`, error instanceof Error ? error.message : String(error))
    }
  }

  const detailRoute = async (request: Request): Promise<Response> => {
    const body = await bodyOf(request)
    const sessionId = body?.sessionId
    const seq = body?.seq
    if (typeof sessionId !== 'string' || sessionId === '' || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      return failure(`${name}/bad-request`, 'missing sessionId or seq')
    }
    try {
      const observation = await observe(sessionId)
      if (observation === null) return reply({ ok: true, detail: null })
      try {
        const events = observation.events
        return reply({ ok: true, detail: Array.isArray(events) ? spanDetail(events as readonly LogEvent[], seq) : null })
      } finally {
        release(observation)
      }
    } catch (error) {
      return failure(`${name}/internal`, error instanceof Error ? error.message : String(error))
    }
  }

  const connection = ctx.get('connection') as ConnectionFace | undefined
  const register = typeof connection?.fetch?.register === 'function'
    ? connection.fetch.register.bind(connection.fetch)
    : undefined
  if (register === undefined) {
    warn('the connection service exposes no fetch routes; the timeline view will have no data')
    return
  }
  const mount = (path: string, fetch: FetchRoute['fetch']): void => {
    ctx.effect(() => register({ path: `/${path}`, methods: ['POST'], requestBody: 'buffered', fetch }), `${name}: ${path}`)
  }
  mount(TIMELINE_ROUTE, timelineRoute)
  mount(DETAIL_ROUTE, detailRoute)
  ctx.effect(() => () => { cache.clear() }, `${name}: timeline cache`)
}
