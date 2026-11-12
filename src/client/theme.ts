/**
 * Resolve the host theme into concrete colors for the canvas. The stylesheet
 * maps the host's semantic tokens onto `--dst-*` custom properties (with
 * fallbacks for a page that has none); this reads them back as rgba strings.
 */
import type { ChartTheme } from './chart.ts'

let scratch: CanvasRenderingContext2D | null = null

/** Any CSS color → `rgba(r,g,b,a)`, by letting a canvas parse it. */
function normalize(color: string, fallback: string): string {
  scratch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (scratch === null) return fallback
  scratch.clearRect(0, 0, 1, 1)
  scratch.fillStyle = '#000000'
  scratch.fillStyle = color
  scratch.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = scratch.getImageData(0, 0, 1, 1).data
  if (a === 0) return fallback
  return `rgba(${r},${g},${b},${((a ?? 255) / 255).toFixed(3)})`
}

function luminance(rgba: string): number {
  const parts = /rgba?\((\d+),(\d+),(\d+)/.exec(rgba)
  if (parts === null) return 0
  return (0.2126 * Number(parts[1]) + 0.7152 * Number(parts[2]) + 0.0722 * Number(parts[3])) / 255
}

/** The color actually painted behind an element: the nearest opaque ancestor background. */
function backdrop(element: HTMLElement): string | null {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor
    if (color !== '' && color !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(color)) {
      const resolved = normalize(color, '')
      if (resolved !== '' && resolved.endsWith(',1.000)')) return resolved
    }
  }
  return null
}

export function readTheme(root: HTMLElement): ChartTheme {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  root.append(probe)
  const resolve = (name: string, fallback: string): string => {
    probe.style.color = `var(${name}, ${fallback})`
    return normalize(getComputedStyle(probe).color, fallback)
  }
  const bg = backdrop(root) ?? resolve('--dst-bg', '#0f1420')
  const theme: ChartTheme = {
    bg,
    raised: resolve('--dst-raised', '#161d2e'),
    text: resolve('--dst-text', '#e6eaf2'),
    text2: resolve('--dst-text2', '#9aa4b8'),
    text3: resolve('--dst-text3', '#66708a'),
    border: resolve('--dst-border', '#232b3d'),
    accent: resolve('--dst-accent', '#4f8ff7'),
    dark: luminance(bg) < 0.5,
  }
  probe.remove()
  return theme
}

/** Call `listener` when the page theme may have changed. */
export function watchTheme(listener: () => void): () => void {
  let timer = 0
  const schedule = (): void => {
    clearTimeout(timer)
    timer = window.setTimeout(listener, 60)
  }
  const observer = new MutationObserver(schedule)
  const attributes = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme', 'data-mode'] }
  observer.observe(document.documentElement, attributes)
  if (document.body !== null) observer.observe(document.body, attributes)
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', schedule)
  return () => {
    clearTimeout(timer)
    observer.disconnect()
    media.removeEventListener('change', schedule)
  }
}
