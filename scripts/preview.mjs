#!/usr/bin/env node
/**
 * Standalone preview: serves the built plugin outside dsh.
 *
 *   node scripts/preview.mjs [--port 4173] [session dir | log file]...
 *
 * The page stands in for the dsh shell (module loader, slot and locale
 * services); the server stands in for the host (it mounts the real host half
 * from lib/index.js on a fake context). Sessions:
 *
 *   ?session=demo   a synthetic session of about three and a half hours (default)
 *   ?session=live   the same log replayed in real time, to exercise polling
 *   ?session=<id>   a real session passed on the command line
 *
 * Also: ?theme=light, ?lang=en, ?view=flame|stats.
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { demoLog, DEMO_CATEGORIES } from './demo-log.mjs'
import { readLog, resolveLog } from './dump-timeline.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const portFlag = args.indexOf('--port')
const port = portFlag >= 0 ? Number(args.splice(portFlag, 2)[1]) : 4173

const sessions = new Map()
sessions.set('demo', { ...demoLog(), live: false })
// Replay: the demo log started 40 minutes ago, revealed as the clock advances.
const replay = demoLog({ start: Date.now() - 40 * 60_000 })
sessions.set('live', { header: { ...replay.header, id: 'live' }, events: replay.events, live: true })
for (const input of args) {
  const { header, events } = readLog(resolveLog(input))
  sessions.set(header.id ?? input, { header, events, live: false })
  console.log(`session ${header.id ?? input}: ${events.length} events`)
}

const eventsOf = (session) => {
  if (!session.live) return session.events
  const now = Date.now()
  let end = session.events.length
  while (end > 0 && session.events[end - 1].time > now) end--
  return session.events.slice(0, end)
}

// Mount the real host half on a context that answers the three services it uses.
const routes = new Map()
const services = {
  connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } },
  sessions: { get: id => (sessions.get(id)?.live ? {} : undefined) },
  sessionQuery: {
    async observeSession(id) {
      const session = sessions.get(id)
      if (session === undefined) return null
      const events = eventsOf(session)
      return {
        source: session.live ? 'live' : 'prepared',
        header: session.header,
        inheritedEventCount: 0,
        events,
        cursor: events.length === 0 ? -1 : events[events.length - 1].seq,
        revision: session.live ? undefined : 'r1',
      }
    },
  },
}
const host = await import(join(root, 'lib/index.js'))
host.apply({
  get: name => services[name],
  effect: (effect) => { effect() },
  logger: { warn: (...parts) => console.warn(...parts) },
// The demo's custom lane would only get in the way of a real session's own commands.
}, { categories: args.length === 0 ? DEMO_CATEGORIES : [] })

const page = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>dsh-session-timeline preview</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { background: #0f1420; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
  body.light {
    background: #ffffff;
    --dsw-alias-bg-base: #ffffff; --dsw-alias-bg-layer-1: #f6f7f9; --dsw-alias-bg-layer-2: #eceef2;
    --dsw-alias-label-primary: #1a1d24; --dsw-alias-label-secondary: #565d6b; --dsw-alias-label-tertiary: #8b93a3;
    --dsw-alias-border-l1: #e4e7ec; --dsw-alias-border-l2: #d3d7df;
    --dsw-alias-interactive-bg-hover: rgba(20, 30, 50, 0.06); --dsw-alias-state-business-primary: #2f6fed;
  }
  #app { height: 100%; }
</style>
</head>
<body>
<div id="app"></div>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>
  const params = new URLSearchParams(location.search)
  if (params.get('theme') === 'light') document.body.classList.add('light')
  if (params.get('view')) localStorage.setItem('dsh-session-timeline:prefs', JSON.stringify({ view: params.get('view') }))
  const modules = { react: React }
  const plugins = []
  window.__ModuleLoader__ = { load({ factory }) { plugins.push(factory(id => modules[id])) } }
</script>
<script src="/client.js"></script>
<script>
  const lang = params.get('lang') === 'en' ? 'en' : 'zh'
  const dicts = {}
  let view = null
  const ctx = {
    effect(effect) { effect() },
    locale: {
      register(ns, table) { dicts[ns] = table; return () => {} },
      bind: ns => (key, values) => {
        let text = dicts[ns]?.[lang]?.[key] ?? dicts[ns]?.en?.[key] ?? key
        for (const name of Object.keys(values ?? {})) text = text.replace('{' + name + '}', String(values[name]))
        return text
      },
    },
    slots: {
      inject(name, callback) { return callback() },
      register(registration, component) { view = { registration, component } },
      entries() { return [] },
    },
  }
  for (const plugin of plugins) plugin.apply(ctx)
  document.title = view.registration.label() + ' · dsh-session-timeline'
  const View = props => view.component(props)
  ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(View, { sessionId: params.get('session') ?? 'demo' }))
</script>
</body>
</html>`

const files = {
  '/client.js': () => readFileSync(join(root, 'lib/client.js')),
  '/react.js': () => readFileSync(join(root, 'node_modules/react/umd/react.production.min.js')),
  '/react-dom.js': () => readFileSync(join(root, 'node_modules/react-dom/umd/react-dom.production.min.js')),
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  try {
    const route = routes.get(url.pathname)
    if (route !== undefined && request.method === 'POST') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const answer = await route.fetch(new Request(url, { method: 'POST', body: Buffer.concat(chunks), headers: { 'content-type': 'application/json' } }))
      response.writeHead(answer.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(Buffer.from(await answer.arrayBuffer()))
      return
    }
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page)
      return
    }
    const file = files[url.pathname]
    if (file === undefined) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    response.end(file())
  } catch (error) {
    response.writeHead(500).end(String(error))
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${port}/  (sessions: ${[...sessions.keys()].join(', ')})`)
})
