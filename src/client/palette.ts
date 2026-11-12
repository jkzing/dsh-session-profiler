/** Lane colors. Fixed hues that read on both the dark and the light host theme. */
import type { Trace } from '../shared/types.ts'

export const CATEGORY_COLOR: Record<string, string> = {
  model: '#5b8def',
  build: '#f59e42',
  shell: '#a78bfa',
  vcs: '#2dd4bf',
  read: '#94a3b8',
  edit: '#f472b6',
  web: '#34d399',
  vision: '#38bdf8',
  agent: '#fbbf24',
  mcp: '#e879f9',
  wait: '#d6b98c',
  other: '#64748b',
}

/** Phases of one model attempt. */
export const SEGMENT_COLOR = {
  wait: '#3b4a6b',
  think: '#818cf8',
  text: '#5b8def',
  call: '#22d3ee',
} as const

/** Hue ramp walked by the phase row, one step per phase. */
export const PHASE_RAMP = [
  '#5b8def', '#7c6ff0', '#a78bfa', '#d977e8', '#f472b6', '#f87171', '#fb923c', '#f5b942', '#a3d94a', '#4ade80', '#2dd4bf', '#38bdf8',
]

/** Fallback hues for config-defined lanes that set no color. */
const CUSTOM_RAMP = ['#34d399', '#f97316', '#60a5fa', '#facc15', '#c084fc', '#fb7185', '#4ade80', '#22d3ee']

export const ERROR_COLOR = '#ef4444'

export function colorsFor(trace: Trace | null): Record<string, string> {
  const colors = { ...CATEGORY_COLOR }
  trace?.categories.forEach((category, index) => {
    colors[category.id] = category.color ?? (CUSTOM_RAMP[index % CUSTOM_RAMP.length] as string)
  })
  return colors
}

export function colorOf(colors: Record<string, string>, cat: string): string {
  return colors[cat] ?? (CATEGORY_COLOR.other as string)
}
