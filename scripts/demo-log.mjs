/**
 * A synthetic session log for the preview page and the tests of the chart:
 * four turns over about three and a half hours, with long-lived dev servers,
 * parallel calls, failures, subagents, an approval and a call that never
 * returned. The scenario is made up. Deterministic: the same seed always
 * yields the same log, and the language only changes the wording.
 */

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOOLS = {
  read: () => ['read', { file_path: pick(FILES) }, [20, 400]],
  grep: () => ['grep', { pattern: pick(['listOrders', 'cursor', 'TODO', 'exportCsv', 'pageSize']), path: 'src' }, [60, 900]],
  glob: () => ['glob', { pattern: pick(['src/**/*.ts', '**/*.test.ts', 'migrations/*.sql']) }, [40, 500]],
  edit: () => ['edit', { file_path: pick(FILES), old_string: 'a', new_string: 'b' }, [15, 120]],
  write: () => ['write', { file_path: pick(FILES), content: '…' }, [15, 90]],
  script: () => ['bash', { command: pick(['node scripts/seed-orders.mjs --count 5000', 'python3 tools/compare_csv.py out/a.csv out/b.csv', 'node scripts/bench-list.mjs --pages 50', './scripts/collect-logs.sh']) }, [800, 14_000]],
  build: () => ['bash', { command: pick(['pnpm run build', 'pnpm test -- orders', 'pnpm run typecheck', 'pnpm lint', 'pnpm install']) }, [4000, 95_000]],
  db: () => ['bash', { command: pick(['psql -c "explain analyze select * from orders order by id limit 50"', 'psql -f migrations/0042_orders_cursor_index.sql', 'pnpm prisma migrate dev --name orders-cursor', 'psql -c "select count(*) from orders"']) }, [300, 9000]],
  git: () => ['bash', { command: pick(['git status -sb', 'git diff --stat', 'git add -A && git commit -m "feat: paginate order list"']) }, [80, 900]],
  shot: () => ['read_image', { path: `out/orders-page-${Math.floor(rand() * 40)}.png` }, [120, 1500]],
  mcp: () => ['mcp__tracker__get_issue', { id: `ORD-${100 + Math.floor(rand() * 60)}` }, [700, 5200]],
  web: () => ['web_fetch', { url: pick(['https://example.com/docs/keyset-pagination', 'https://example.com/docs/csv-streaming']) }, [600, 4800]],
  todo: () => ['todo_write', { todos: [] }, [3, 12]],
}

const FILES = [
  'src/routes/orders.ts', 'src/services/order-list.ts', 'src/services/order-export.ts',
  'src/db/orders.repo.ts', 'src/web/OrdersPage.tsx', 'src/web/OrdersTable.tsx', 'tests/orders.test.ts',
  'migrations/0042_orders_cursor_index.sql', 'package.json',
]

/** Everything a person wrote in the session, per language. */
const TEXT = {
  zh: {
    title: '订单列表分页与导出',
    done: '已完成这一步，接下来继续验证。',
    approval: '需要写入工作区之外的缓存目录',
    subagents: ['梳理订单查询的调用链', '检查列表页的渲染开销', '调研游标分页的做法'],
    prompts: [
      '订单列表数据多了以后很慢，先看看现在是怎么查询和渲染的，给出分页方案',
      '按游标分页的方案实现，接口和页面都要改',
      '再加一个导出 CSV 的功能，数据量大的时候不能把内存撑爆',
      '端到端测试卡住了先不管，把已有改动整理好提 PR',
    ],
    phases: [
      ['梳理现有查询与页面'],
      ['实现游标分页接口', '改造列表页', '补充测试'],
      ['设计流式导出', '实现导出接口', '压测与内存排查'],
      ['清理与自测', '提交并创建 PR'],
    ],
    database: '数据库',
  },
  en: {
    title: 'Order list pagination and export',
    done: 'That step is done; verifying it next.',
    approval: 'needs to write to a cache directory outside the workspace',
    subagents: ['Trace the order query call chain', 'Measure the list page render cost', 'Research keyset pagination'],
    prompts: [
      'The order list gets slow once there is a lot of data. Look at how it queries and renders today, then propose a pagination plan',
      'Go with cursor pagination; both the API and the page need to change',
      'Add a CSV export as well, and it must not blow up memory on large data sets',
      'Leave the stuck end-to-end test for now; tidy up what we have and open a PR',
    ],
    phases: [
      ['Map queries and page'],
      ['Cursor API', 'List page', 'Add tests'],
      ['Plan export', 'Build the export endpoint', 'Load test and memory'],
      ['Tidy and test', 'Open PR'],
    ],
    database: 'Database',
  },
}
const textFor = lang => TEXT[lang] ?? TEXT.zh

let rand = mulberry32(1)
function pick(list) { return list[Math.floor(rand() * list.length)] }
function between([lo, hi]) { return Math.round(lo + (hi - lo) * rand() ** 2) }

/**
 * @param {{ start?: number, seed?: number, lang?: 'zh' | 'en' }} [options]
 * @returns {{ header: object, events: object[] }}
 */
export function demoLog(options = {}) {
  rand = mulberry32(options.seed ?? 7)
  const text = textFor(options.lang)
  const start = options.start ?? new Date(2026, 2, 9, 10, 5, 0).getTime()
  const events = []
  let now = start
  let callSeq = 0
  const emit = (type, data, time = now) => { events.push({ type, seq: events.length, time, data }) }
  const later = (ms) => { now += Math.max(1, Math.round(ms)) }

  /** Processes started in the background, settled when their time comes. */
  const pending = []
  const settleDue = () => {
    for (const job of pending.filter(job => !job.done && job.end <= now)) {
      job.done = true
      emit('job/settled', { jobId: job.id, kind: 'bash', label: job.label, startedAt: job.start, finishedAt: job.end, status: job.status, detail: job.status === 'completed' ? 'exit code: 0' : 'signal: SIGTERM' }, job.end)
    }
    events.sort((a, b) => a.time - b.time)
    events.forEach((event, index) => { event.seq = index })
  }

  emit('model/selection', { provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' })
  emit('session/title', { title: text.title })

  const modelCall = (turn, step, plan) => {
    emit('step/start', { turn, step })
    later(6)
    const s = now
    const wait = between([700, 5200])
    const think = rand() < 0.75 ? between([900, 26_000]) : 0
    const out = between([400, 9000])
    const stream = []
    let t = s + wait
    let index = 0
    if (think > 0) {
      stream.push({ type: 'chunk', time: t, chunk: { type: 'block-start', index, blockType: 'reasoning' } })
      t += think
      stream.push({ type: 'chunk', time: t, chunk: { type: 'block-end', index } })
      index++
    }
    const blockType = plan.length > 0 ? 'tool-call' : 'text'
    stream.push({ type: 'chunk', time: t + 20, chunk: { type: 'block-start', index, blockType } })
    t += 20 + out
    stream.push({ type: 'chunk', time: t, chunk: { type: 'block-end', index } })
    now = t + 15
    const content = plan.length > 0
      ? plan.map(([name]) => ({ type: 'tool-call', name }))
      : [{ type: 'text', text: text.done }]
    emit('assistant/message', {
      turn, step, stream,
      message: { role: 'assistant', content, source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-pro' } },
      usage: { inputTokens: 18_000 + Math.floor(rand() * 90_000), outputTokens: 60 + Math.floor((think + out) / 28) },
    })
  }

  const toolCall = (turn, step, [name, args, range], options = {}) => {
    const callId = `call_${++callSeq}`
    const duration = options.duration ?? between(range)
    emit('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) })
    const s = now
    if (options.approval) {
      later(40)
      emit('approval/asked', { id: `ap_${callSeq}`, toolName: name, callId, reason: `escalate sandbox: ${text.approval}` })
      later(between([6000, 38_000]))
      emit('approval/decided', { id: `ap_${callSeq}`, outcome: 'allowed-once' })
    }
    if (options.background) {
      later(12)
      const job = { id: `bash-${callSeq}`, label: args.command, start: now, end: now + options.background, status: options.killed ? 'killed' : 'completed', done: false }
      pending.push(job)
      emit('job/registered', { jobId: job.id, kind: 'bash', label: job.label, startedAt: job.start, toolCall: { callId, rootCallId: callId } })
      later(180)
    } else if (options.hang) {
      return callId
    } else {
      now = Math.max(now, s + duration)
    }
    const isError = options.error ?? (name === 'bash' && rand() < 0.07)
    emit('tool/result', {
      turn, step,
      message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: isError ? 'exit code: 1\nError: assertion failed' : 'ok' }], isError },
      ...(isError ? { error: { name: 'ToolError', code: 'COMMAND_FAILED' } } : {}),
    })
    later(2)
    return callId
  }

  const todos = (items, active) => {
    emit('todo/write', { todos: items.map((content, i) => ({ content, status: i < active ? 'completed' : i === active ? 'in_progress' : 'pending' })) })
  }

  /** One turn: phases of work, each a run of steps drawing tools from the phase's mix. */
  const turn = (number, prompt, phases, extra = {}) => {
    emit('turn/start', { turn: number })
    later(4)
    emit('user/message', { role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
    let step = 0
    const names = phases.map(phase => phase.name)
    phases.forEach((phase, phaseIndex) => {
      const until = now + phase.minutes * 60_000
      let first = true
      while (now < until) {
        step++
        const plan = []
        const parallel = rand() < 0.3 ? 1 + Math.floor(rand() * 3) : 1
        for (let i = 0; i < parallel; i++) plan.push(TOOLS[pick(phase.mix)]())
        if (first) plan.unshift(TOOLS.todo())
        modelCall(number, step, plan)
        if (first) {
          const callId = `call_${++callSeq}`
          emit('tool/call', { turn: number, step, callId, name: 'todo_write', arguments: JSON.stringify({ todos: names.map((content, i) => ({ content, status: i === phaseIndex ? 'in_progress' : 'pending' })) }) })
          later(5)
          todos(names, phaseIndex)
          emit('tool/result', { turn: number, step, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'ok' }], isError: false } })
          plan.shift()
          first = false
          for (const special of phase.once ?? []) special(number, step)
        }
        if (parallel > 1) {
          // Parallel calls start together and return as each finishes.
          const started = plan.map(([name, args, range]) => {
            const callId = `call_${++callSeq}`
            emit('tool/call', { turn: number, step, callId, name, arguments: JSON.stringify(args) }, now + 1)
            return { callId, end: now + between(range) }
          })
          for (const call of started.sort((a, b) => a.end - b.end)) {
            now = Math.max(now, call.end)
            emit('tool/result', { turn: number, step, message: { role: 'tool', toolCallId: call.callId, content: [{ type: 'text', text: 'ok' }], isError: false } })
          }
        } else {
          for (const spec of plan) toolCall(number, step, spec)
        }
        later(8)
        emit('step/end', { turn: number, step })
        later(between([20, 400]))
        settleDue()
      }
    })
    if (extra.hang) {
      step++
      modelCall(number, step, [TOOLS.build()])
      toolCall(number, step, ['bash', { command: 'pnpm exec playwright test e2e/export.spec.ts' }, [0, 0]], { hang: true })
      later(95_000)
      emit('turn/end', { turn: number, reason: { kind: 'aborted' } })
    } else {
      step++
      modelCall(number, step, [])
      emit('step/end', { turn: number, step })
      later(10)
      todos(names, names.length)
      emit('turn/end', { turn: number, reason: { kind: 'completed' } })
    }
    settleDue()
  }

  const background = (command, minutes, options = {}) => (number, step) => {
    toolCall(number, step, ['bash', { command, run_in_background: true }, [0, 0]], { background: minutes * 60_000, ...options })
  }
  const subagents = (number, step) => {
    for (const label of text.subagents) {
      const callId = toolCall(number, step, ['subagent', { description: label, prompt: '…' }, [80, 200]])
      const childId = `child-${callId}`
      emit('subagent/catalog', { version: 0, childId, childCreatedAt: now - 60, mode: 'continuable', label })
      const settle = now + between([4 * 60_000, 26 * 60_000])
      emit('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [{ role: 'user', content: [], source: { kind: 'subagent-settled', senderSessionId: childId } }] }, settle)
    }
  }
  const approval = (number, step) => {
    toolCall(number, step, ['bash', { command: 'pnpm install --frozen-lockfile' }, [18_000, 40_000]], { approval: true, error: false })
  }

  turn(1, text.prompts[0], [
    { name: text.phases[0][0], minutes: 15, mix: ['read', 'grep', 'glob', 'mcp', 'read', 'db', 'shot'], once: [subagents] },
  ])
  later(230_000)
  turn(2, text.prompts[1], [
    { name: text.phases[1][0], minutes: 12, mix: ['edit', 'edit', 'read', 'write', 'grep', 'db'], once: [background('docker compose up db', 132, { killed: true })] },
    { name: text.phases[1][1], minutes: 14, mix: ['edit', 'shot', 'read', 'script', 'edit'], once: [background('pnpm dev --host 0.0.0.0', 96, { killed: true })] },
    { name: text.phases[1][2], minutes: 11, mix: ['edit', 'build', 'build', 'read', 'git'], once: [approval] },
  ])
  later(4_300_000)
  turn(3, text.prompts[2], [
    { name: text.phases[2][0], minutes: 9, mix: ['read', 'web', 'web', 'grep', 'db'] },
    { name: text.phases[2][1], minutes: 22, mix: ['edit', 'edit', 'script', 'db', 'read', 'build'], once: [background('pnpm test --watch orders', 34)] },
    { name: text.phases[2][2], minutes: 19, mix: ['script', 'script', 'db', 'shot', 'read', 'edit'] },
  ], { hang: true })
  later(170_000)
  turn(4, text.prompts[3], [
    { name: text.phases[3][0], minutes: 13, mix: ['read', 'edit', 'build', 'script', 'git'] },
    { name: text.phases[3][1], minutes: 8, mix: ['git', 'git', 'build', 'read'] },
  ])

  settleDue()
  return {
    header: { type: 'session', version: 4, id: 'demo', createdAt: start, cwd: '/work/miniapp' },
    events,
  }
}

/**
 * A custom lane the demo is drawn with, as a profile would configure one.
 * @param {'zh' | 'en'} [lang]
 */
export function demoCategories(lang) {
  return [{ id: 'database', label: textFor(lang).database, color: '#f97316', match: '\\b(psql|prisma)\\b' }]
}
