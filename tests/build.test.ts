import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyDelta, buildTrace, deltaSince, spanDetail, type LogEvent } from '../src/shared/build.ts'
import { classifyTool, compileRules } from '../src/shared/classify.ts'
import { summarize, unionLength } from '../src/shared/stats.ts'

const T0 = 1_700_000_000_000

/** Build a log from `[type, msOffset, data]` rows; seq is the row index. */
function log(rows: [string, number, unknown?][]): LogEvent[] {
  return rows.map(([type, offset, data], seq) => ({ type, seq, time: T0 + offset, data: data ?? {} }))
}

function call(callId: string, name: string, args: unknown, turn = 1, step = 1) {
  return { turn, step, callId, name, arguments: JSON.stringify(args) }
}

function result(callId: string, isError = false) {
  return { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'out' }], isError } }
}

function assistant(firstToken: number, blocks: [string, number, number][], extra: Record<string, unknown> = {}) {
  const stream: unknown[] = []
  blocks.forEach(([blockType, s, e], index) => {
    stream.push({ type: 'chunk', time: T0 + s, chunk: { type: 'block-start', index, blockType } })
    stream.push({ type: 'chunk', time: T0 + e, chunk: { type: 'block-end', index } })
  })
  if (blocks.length === 0) stream.push({ type: 'text-chunks', time0: T0 + firstToken, index: 0, dt: [10], texts: ['a', 'b'] })
  return {
    turn: 1, step: 1, stream,
    message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', model: 'm-1' } },
    usage: { inputTokens: 100, outputTokens: 20 },
    ...extra,
  }
}

const BASIC = log([
  ['turn/start', 0, { turn: 1 }],
  ['step/start', 10, { turn: 1, step: 1 }],
  ['user/message', 12, { content: [{ type: 'text', text: 'fix the bug' }], source: { kind: 'user' } }],
  ['request/header', 15, { header: { config: { model: 'm-1' } }, reason: 'initial' }],
  ['assistant/message', 2000, assistant(500, [['reasoning', 500, 1200], ['tool-call', 1300, 1900]])],
  ['tool/call', 2001, call('c1', 'bash', { command: 'pnpm run build' })],
  ['job/registered', 2010, { jobId: 'j1', kind: 'bash', label: 'pnpm run build', startedAt: T0 + 2010, toolCall: { callId: 'c1' } }],
  ['job/settled', 5000, { jobId: 'j1', finishedAt: T0 + 5000, status: 'completed' }],
  ['tool/result', 5001, result('c1')],
  ['tool/call', 5002, call('c2', 'read', { file_path: '/a/b.ts' })],
  ['tool/result', 5030, result('c2', true)],
  ['step/end', 5031, { turn: 1, step: 1 }],
  ['turn/end', 5040, { turn: 1, reason: { kind: 'completed' } }],
])

test('folds turns, steps, model and tool spans', () => {
  const trace = buildTrace(BASIC, { sessionId: 's', live: false, now: T0 + 99_999 })
  assert.equal(trace.cursor, 12)
  assert.equal(trace.running, false)
  assert.equal(trace.turns.length, 1)
  assert.deepEqual(
    { label: trace.turns[0]?.label, reason: trace.turns[0]?.reason, steps: trace.turns[0]?.steps, source: trace.turns[0]?.source },
    { label: 'fix the bug', reason: 'completed', steps: 1, source: 'user' },
  )
  assert.equal(trace.start, T0)
  assert.equal(trace.end, T0 + 5040)

  // The foreground job is folded into its tool call rather than drawn twice.
  assert.deepEqual(trace.spans.map(s => s.kind), ['model', 'tool', 'tool'])
  const [model, build, read] = trace.spans
  assert.deepEqual([model?.s, model?.e, model?.name], [T0 + 15, T0 + 2000, 'm-1'])
  assert.deepEqual(model?.segs?.map(seg => [seg.k, seg.s - T0, seg.e - T0]), [
    ['wait', 15, 500], ['think', 500, 1200], ['call', 1300, 1900],
  ])
  assert.deepEqual(model?.tok, { in: 100, out: 20 })
  assert.deepEqual([build?.cat, build?.label, build?.e! - build?.s!], ['build', 'pnpm run build', 3000])
  assert.deepEqual([read?.cat, read?.label, read?.err], ['read', '/a/b.ts', true])
})

test('a process that outlives its call becomes a background span', () => {
  const events = log([
    ['turn/start', 0, { turn: 1 }],
    ['step/start', 1, { turn: 1, step: 1 }],
    ['assistant/message', 100, assistant(50, [])],
    ['tool/call', 101, call('c1', 'bash', { command: 'pnpm dev', run_in_background: true })],
    ['job/registered', 110, { jobId: 'j1', kind: 'bash', label: 'pnpm dev', startedAt: T0 + 110, toolCall: { callId: 'c1' } }],
    ['tool/result', 150, result('c1')],
    ['step/end', 151, { turn: 1, step: 1 }],
    ['turn/end', 160, { turn: 1, reason: { kind: 'completed' } }],
    ['job/settled', 90_000, { jobId: 'j1', finishedAt: T0 + 90_000, status: 'killed' }],
  ])
  const trace = buildTrace(events, { sessionId: 's', live: false, now: T0 + 99_999 })
  const job = trace.spans.find(s => s.kind === 'job')
  assert.ok(job)
  assert.deepEqual([job.bg, job.cat, job.s - T0, job.e - T0, job.open, job.parent], [true, 'build', 110, 90_000, undefined, 1])

  // Before it settles the process is open; in a live session it is still running.
  const cut = buildTrace(events.slice(0, 8), { sessionId: 's', live: true, now: T0 + 60_000 })
  const running = cut.spans.find(s => s.kind === 'job')
  assert.deepEqual([running?.open, running?.run, running?.e! - T0], [true, true, 60_000])
  // …but it does not stretch a finished turn's trace to "now".
  assert.equal(cut.end, T0 + 160)
})

test('open spans: running in a live turn, frozen when the turn ended without a result', () => {
  const events = log([
    ['turn/start', 0, { turn: 1 }],
    ['step/start', 1, { turn: 1, step: 1 }],
    ['assistant/message', 100, assistant(50, [])],
    ['tool/call', 101, call('c1', 'bash', { command: 'sleep 100' })],
  ])
  const live = buildTrace(events, { sessionId: 's', live: true, now: T0 + 4000 })
  assert.equal(live.running, true)
  assert.deepEqual([live.spans[1]?.open, live.spans[1]?.run, live.spans[1]?.e! - T0], [true, true, 4000])
  assert.equal(live.end, T0 + 4000)
  assert.equal(live.turns[0]?.open, true)

  const aborted = buildTrace(
    [...events, ...log([['turn/end', 900, { turn: 1, reason: { kind: 'aborted' } }]]).map(e => ({ ...e, seq: 4 }))],
    { sessionId: 's', live: true, now: T0 + 4000 },
  )
  assert.equal(aborted.running, false)
  assert.deepEqual([aborted.spans[1]?.open, aborted.spans[1]?.run, aborted.spans[1]?.e! - T0], [true, undefined, 900])
  assert.equal(aborted.turns[0]?.reason, 'aborted')
})

test('failed attempts and retries are separate model spans', () => {
  const events = log([
    ['turn/start', 0, { turn: 1 }],
    ['step/start', 10, { turn: 1, step: 1 }],
    ['assistant/attempt', 800, { turn: 1, step: 1, stream: [{ type: 'chunk', time: T0 + 799, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'SERVER' } } } }] }],
    ['llm/retry', 801, { retry: 1, delayMs: 500 }],
    ['llm/retry-started', 1300, { retry: 1 }],
    ['assistant/message', 3000, assistant(1800, [])],
    ['step/end', 3001, { turn: 1, step: 1 }],
    ['turn/end', 3002, { turn: 1, reason: { kind: 'completed' } }],
  ])
  const trace = buildTrace(events, { sessionId: 's', live: false, now: T0 })
  assert.deepEqual(trace.spans.map(s => [s.s - T0, s.e - T0, s.err ?? false]), [[10, 800, true], [1300, 3000, false]])
  assert.deepEqual(spanDetail(events, 2), { seq: 2, result: 'boom', isError: true, errorCode: 'SERVER' })
})

test('phases follow the in-progress todo', () => {
  const todo = (...items: [string, string][]) => ({ todos: items.map(([content, status]) => ({ content, status })) })
  const events = log([
    ['turn/start', 0, { turn: 1 }],
    ['user/message', 1, { content: 'ship it', source: { kind: 'user' } }],
    ['todo/write', 90_000, todo(['explore', 'in_progress'], ['build', 'pending'])],
    ['todo/write', 95_000, todo(['explore', 'in_progress'], ['build', 'pending'])],
    ['todo/write', 200_000, todo(['explore', 'completed'], ['build', 'in_progress'])],
    ['todo/write', 300_000, todo(['explore', 'completed'], ['build', 'completed'])],
    ['turn/end', 330_000, { turn: 1, reason: { kind: 'completed' } }],
  ])
  const trace = buildTrace(events, { sessionId: 's', live: false, now: T0 })
  assert.deepEqual(trace.phases.map(p => [p.src, p.label, p.s - T0, p.e - T0]), [
    ['prompt', 'ship it', 0, 90_000],
    ['todo', 'explore', 90_000, 200_000],
    ['todo', 'build', 200_000, 300_000],
    ['wrap', '', 300_000, 330_000],
  ])

  // A plan written right after the prompt, and a sign-off right after the last item, are not phases of their own.
  const quick = log([
    ['turn/start', 0, { turn: 1 }],
    ['user/message', 1, { content: 'ship it', source: { kind: 'user' } }],
    ['todo/write', 4000, todo(['explore', 'in_progress'])],
    ['todo/write', 50_000, todo(['explore', 'completed'])],
    ['turn/end', 52_000, { turn: 1, reason: { kind: 'completed' } }],
  ])
  const merged = buildTrace(quick, { sessionId: 's', live: false, now: T0 })
  assert.deepEqual(merged.phases.map(p => [p.src, p.label, p.s - T0, p.e - T0]), [['todo', 'explore', 0, 52_000]])
  assert.equal(merged.turns[0]?.label, 'ship it')
})

test('subagents run from launch until they settle, and again when messaged', () => {
  const events = log([
    ['turn/start', 0, { turn: 1 }],
    ['tool/call', 100, call('c1', 'subagent', { description: 'audit' })],
    ['subagent/catalog', 120, { childId: 'child-1', childCreatedAt: T0 + 110, label: 'audit' }],
    ['tool/result', 130, result('c1')],
    ['agent/inbox/spliced', 8000, { inserted: [{ source: { kind: 'subagent-settled', senderSessionId: 'child-1' } }] }],
    ['tool/call', 9000, call('c2', 'send_message', { agent_id: 'child-1', message: 'more' })],
    ['tool/result', 9010, result('c2')],
    ['turn/end', 9500, { turn: 1, reason: { kind: 'completed' } }],
  ])
  const trace = buildTrace(events, { sessionId: 's', live: false, now: T0 })
  const agents = trace.spans.filter(s => s.kind === 'agent')
  assert.deepEqual(agents.map(s => [s.label, s.s - T0, s.e - T0, s.open ?? false]), [
    ['audit', 110, 8000, false],
    ['audit', 9000, 9500, true],
  ])
})

test('delta carries exactly what changed since the client cursor', () => {
  const options = { sessionId: 's', live: true, now: T0 + 6000 }
  for (let at = 1; at < BASIC.length; at++) {
    const before = buildTrace(BASIC.slice(0, at), options)
    const after = buildTrace(BASIC, options)
    const delta = deltaSince(after, before.cursor)
    assert.deepEqual(applyDelta(before, delta), after, `prefix of ${at} events`)
  }
  const full = buildTrace(BASIC, options)
  assert.deepEqual(deltaSince(full, full.cursor).spans, [])
})

test('inherited fork prefix is skipped', () => {
  const trace = buildTrace(BASIC, { sessionId: 's', live: false, now: T0, inherited: 9 })
  assert.deepEqual(trace.spans.map(s => s.name), ['read'])
  assert.equal(trace.turns.length, 0)
})

test('span detail returns arguments and the paired result', () => {
  const detail = spanDetail(BASIC, 5)
  assert.equal(detail?.args, JSON.stringify({ command: 'pnpm run build' }, null, 2))
  assert.equal(detail?.result, 'out')
  assert.equal(spanDetail(BASIC, 9)?.isError, true)
  assert.equal(spanDetail(BASIC, 0), null)
  assert.equal(spanDetail(BASIC, 999), null)
})

test('classification: built-in lanes', () => {
  const cat = (name: string, args: unknown) => classifyTool(name, JSON.stringify(args)).cat
  assert.equal(cat('bash', { command: 'cd app && pnpm run build' }), 'build')
  assert.equal(cat('bash', { command: 'FOO=1 timeout 30 cargo test' }), 'build')
  assert.equal(cat('bash', { command: 'git status -sb; git log --oneline -8' }), 'vcs')
  assert.equal(cat('bash', { command: 'ls -la && cat package.json | head -20' }), 'read')
  assert.equal(cat('bash', { command: 'curl -s https://example.com | jq .' }), 'web')
  assert.equal(cat('bash', { command: 'node scripts/migrate.js' }), 'shell')
  assert.equal(cat('edit', { file_path: 'a.ts' }), 'edit')
  assert.equal(cat('mcp__tracker__get_issue', {}), 'mcp')
  assert.equal(cat('read_image', { path: 'shot.png' }), 'vision')
  assert.equal(cat('subagent_fork', { description: 'x' }), 'agent')
  assert.equal(cat('ask_user_question', { questions: [{ question: 'which?' }] }), 'wait')
  assert.equal(cat('todo_write', { todos: [] }), 'other')
  assert.equal(classifyTool('bash', '{not json').cat, 'shell')
})

test('classification: custom rules win and bad rules are reported', () => {
  const warnings: string[] = []
  const rules = compileRules([
    { id: 'database', label: '数据库', color: '#f97316', match: 'psql |prisma' },
    { id: 'bad id!', match: 'x' },
    { id: 'broken', match: '(' },
    { id: 'empty' },
  ], message => warnings.push(message))
  assert.deepEqual(rules.categories, [{ id: 'database', label: '数据库', color: '#f97316' }])
  assert.equal(warnings.length, 3)
  assert.equal(classifyTool('bash', JSON.stringify({ command: 'psql -c "select 1"' }), rules.rules).cat, 'database')
  assert.equal(classifyTool('bash', JSON.stringify({ command: 'pnpm build' }), rules.rules).cat, 'build')
})

test('statistics partition the time inside turns', () => {
  assert.equal(unionLength([[0, 10], [5, 20], [30, 40]]), 30)
  const trace = buildTrace(BASIC, { sessionId: 's', live: false, now: T0 })
  const stats = summarize(trace)
  assert.equal(stats.active, 5040)
  assert.equal(stats.model, 1985)
  assert.equal(stats.tool, 3000 + 28)
  assert.equal(stats.wait, 0)
  assert.equal(stats.model + stats.tool + stats.wait + stats.overhead, stats.active)
  assert.deepEqual([stats.modelCalls, stats.toolCalls, stats.errors, stats.tokensIn, stats.tokensOut], [1, 2, 1, 100, 20])
  assert.equal(stats.ttft, 485)
  assert.deepEqual(stats.tools.map(t => [t.name, t.n, t.sum]), [['bash', 1, 3000], ['read', 1, 28]])
})
