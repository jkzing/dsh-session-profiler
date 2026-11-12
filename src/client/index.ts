/**
 * Browser half: registers the timeline tab into the conversation view ring.
 *
 * The bundle is a closure factory the dsh shell loads into its module table;
 * `react` comes from the shell through the injected `require`, everything
 * else is inlined. The entry must be a CommonJS `module.exports` plugin.
 */
import { createElement } from 'react'
import { DICTS, NS, type Translate } from './i18n.ts'
import { TimelineView } from './TimelineView.tsx'
import css from './styles.css'

interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): Translate
}

interface SlotRegistration {
  name: string
  id: string
  order: number
  locale: string
  label: () => string
}

interface SlotsService {
  inject(name: string, callback: () => unknown): unknown
  register(registration: SlotRegistration, component: (props: { sessionId?: string }) => unknown): unknown
  entries?(name: string): unknown
}

interface ClientContext {
  locale: LocaleService
  slots: SlotsService
  effect(effect: () => unknown, label?: string): unknown
}

const VIEW_SLOT = 'conversation.view'
const VIEW_ID = 'session-profiler'
const STYLE_ID = 'dsh-session-profiler-style'

/** True when a previous load of this bundle already holds the tab (hot reload). */
function seated(ctx: ClientContext): boolean {
  try {
    const entries = ctx.slots.entries?.(VIEW_SLOT)
    if (!Array.isArray(entries)) return false
    return entries.some((entry: { options?: { id?: unknown } } | null) => entry?.options?.id === VIEW_ID)
  } catch {
    return false
  }
}

function apply(ctx: ClientContext): void {
  if (seated(ctx)) return
  ctx.effect(() => {
    document.getElementById(STYLE_ID)?.remove()
    const tag = document.createElement('style')
    tag.id = STYLE_ID
    tag.dataset.plugin = NS
    tag.textContent = css
    document.head.append(tag)
    return () => { tag.remove() }
  }, `${NS}: stylesheet`)
  ctx.effect(() => ctx.locale.register(NS, DICTS), `${NS}: dictionaries`)
  const t = ctx.locale.bind(NS)
  // Order 15 sits the tab between Trajectory (10) and plugin tabs registered at 20.
  ctx.slots.inject(VIEW_SLOT, () => ctx.slots.register(
    { name: VIEW_SLOT, id: VIEW_ID, order: 15, locale: NS, label: () => t('tab') },
    props => createElement(TimelineView, { sessionId: props.sessionId, t }),
  ))
}

module.exports = {
  name: NS,
  inject: ['slots', 'locale'],
  apply,
}
