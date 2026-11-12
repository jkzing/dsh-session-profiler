#!/usr/bin/env node
/**
 * Offline fold: decode a persisted dsh session log and print its timeline as JSON.
 *
 *   node scripts/dump-timeline.mjs <session dir | session.vN.jsonl.zstd | .jsonl> [--summary]
 *
 * The persisted log is a concatenation of Zstandard frames, which the `zstd`
 * CLI decodes; a plain .jsonl file is read as is.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildTimeline } from '../src/shared/build.ts'
import { summarize } from '../src/shared/stats.ts'

export function resolveLog(input) {
  if (!statSync(input).isDirectory()) return input
  const logs = readdirSync(input).filter(name => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name)).sort()
  if (logs.length === 0) throw new Error(`no session log in ${input}`)
  return join(input, logs[logs.length - 1])
}

export function readLog(file) {
  const text = file.endsWith('.zstd')
    ? execFileSync('zstd', ['-dc', '--', file], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'] }).toString('utf8')
    : readFileSync(file, 'utf8')
  let header = {}
  const events = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const row = JSON.parse(line)
    if (row.type === 'session' && row.seq === undefined) header = row
    else events.push(row)
  }
  return { header, events }
}

export function timelineOfLog(file, options = {}) {
  const { header, events } = readLog(resolveLog(file))
  return buildTimeline(events, {
    sessionId: header.id ?? 'unknown',
    live: false,
    now: Date.now(),
    ...options,
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, flag] = process.argv.slice(2)
  if (input === undefined) {
    console.error('usage: node scripts/dump-timeline.mjs <session dir | log file> [--summary]')
    process.exit(2)
  }
  const timeline = timelineOfLog(input)
  if (flag === '--summary') {
    const { spans, steps, ...rest } = timeline
    console.log(JSON.stringify({ ...rest, spans: spans.length, steps: steps.length, stats: summarize(timeline) }, null, 2))
  } else {
    console.log(JSON.stringify(timeline))
  }
}
