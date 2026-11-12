/** Number and time formatting shared by the chart, the tooltip and the tables. */

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

/** Compact duration for labels drawn on the chart: 850ms, 12.3s, 22m, 3.4h, 2.1d. */
export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) {
    const minutes = ms / 60_000
    return minutes < 10 ? `${minutes.toFixed(1)}m` : `${Math.round(minutes)}m`
  }
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`
  return `${(ms / 86_400_000).toFixed(1)}d`
}

/** Exact duration for tooltips and details: 850 ms, 12.34 s, 3m 20s, 1h 02m, 2d 3h. */
export function fmtDurLong(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`
}

/** Wall-clock time, with as much precision as the tick spacing calls for. */
export function fmtClock(time: number, stepMs = 1000): string {
  const date = new Date(time)
  const base = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (stepMs >= 60_000) return base
  const withSeconds = `${base}:${pad(date.getSeconds())}`
  if (stepMs >= 1000) return withSeconds
  return `${withSeconds}.${pad(date.getMilliseconds(), 3)}`
}

export function fmtDate(time: number): string {
  const date = new Date(time)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function sameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/** 1234 → 1.2k, 1234567 → 1.23M. */
export function fmtCount(value: number): string {
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

export function fmtPct(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  const pct = (part / whole) * 100
  if (pct > 0 && pct < 0.1) return '<0.1%'
  return `${pct.toFixed(pct < 10 ? 1 : 0)}%`
}
