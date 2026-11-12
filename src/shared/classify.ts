/**
 * Tool call → lane. Pure and synchronous: the host calls it once per call
 * while folding the log. Custom rules from config win over the built-ins.
 */
import type { BuiltinCategory, CustomCategory } from './types.ts'

export interface CustomRuleConfig {
  id?: unknown
  label?: unknown
  color?: unknown
  /** Regular expression source, tested against `"<tool name> <label>"`. */
  match?: unknown
}

export interface CompiledRule {
  id: string
  pattern: RegExp
}

export interface RuleSet {
  rules: CompiledRule[]
  categories: CustomCategory[]
}

const LABEL_MAX = 180
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i

/**
 * Validate the `categories` config. Bad rows are skipped and reported rather
 * than failing the plugin: a typo in a regular expression should not take the
 * whole view down.
 */
export function compileRules(input: unknown, warn: (message: string) => void = () => {}): RuleSet {
  const rules: CompiledRule[] = []
  const categories: CustomCategory[] = []
  if (!Array.isArray(input)) return { rules, categories }
  const seen = new Set<string>()
  for (const row of input as CustomRuleConfig[]) {
    if (row === null || typeof row !== 'object') continue
    const id = typeof row.id === 'string' ? row.id : ''
    if (!ID_PATTERN.test(id)) {
      warn(`category id ${JSON.stringify(row.id)} must match ${ID_PATTERN.source}`)
      continue
    }
    if (typeof row.match !== 'string' || row.match === '') {
      warn(`category "${id}" has no match pattern`)
      continue
    }
    let pattern: RegExp
    try {
      pattern = new RegExp(row.match, 'i')
    } catch (error) {
      warn(`category "${id}" match is not a valid regular expression: ${String(error)}`)
      continue
    }
    rules.push({ id, pattern })
    if (seen.has(id)) continue
    seen.add(id)
    const category: CustomCategory = { id, label: typeof row.label === 'string' && row.label !== '' ? row.label : id }
    if (typeof row.color === 'string' && COLOR_PATTERN.test(row.color)) category.color = row.color
    categories.push(category)
  }
  return { rules, categories }
}

function clip(text: string, max = LABEL_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

type Args = Record<string, unknown>

/** Parse raw tool-call arguments; a model may emit malformed JSON. */
export function parseArgs(raw: unknown): Args {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw as Args
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Args : {}
  } catch {
    return {}
  }
}

const BUILD_COMMAND = new RegExp([
  String.raw`\b(npm|pnpm|yarn|bun|npx|deno)\s+(run\s+|exec\s+)?(build|dev|start|serve|preview|test|lint|typecheck|check|install|i|ci|add|bundle|watch|e2e)\b`,
  String.raw`\b(make|cmake|ninja|cargo|tsc|tsdown|tsup|vite|vitest|webpack|rollup|esbuild|turbo|nx|gradle|gradlew|mvn|xcodebuild|pytest|jest|playwright|tox|rake|dotnet|flutter|terraform|ansible|ansible-playbook|kubectl|helm|docker|docker-compose|podman)\b`,
  String.raw`\bgo\s+(build|test|run|vet|generate|install)\b`,
  String.raw`\bswift\s+(build|test|run)\b`,
  String.raw`\b(pip3?|uv|poetry|pdm|conda|bundle|pod|brew|apt|apt-get)\s+(install|sync|add|update|upgrade)\b`,
  String.raw`\buv\s+run\b`,
].join('|'))

const VCS_COMMAND = /^(git|gh|glab|hg|svn|jj)\b/
const WEB_COMMAND = /^(curl|wget|http|https|xh|ping|dig|nslookup|nc|ssh|scp|rsync)\b/
const READ_COMMAND = /^(cat|bat|ls|ll|tree|rg|grep|egrep|ag|fd|find|head|tail|wc|stat|file|du|df|jq|yq|which|whereis|type|pwd|echo|printf|diff|nl|sort|uniq|cut|awk|less|more|realpath|readlink|basename|dirname|date|env|printenv|id|whoami|uname|ps|lsof|test|true)\b/
const READ_ONLY_SED = /^sed\s+(-[nE]+\s+)*['"]?[0-9,$]*p/

/** Strip `cd x &&`, env assignments and wrappers so the real command leads. */
function commandHead(segment: string): string {
  let rest = segment.trim()
  for (let i = 0; i < 6; i++) {
    const before = rest
    rest = rest.replace(/^\(+\s*/, '')
    rest = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/, '')
    rest = rest.replace(/^(sudo|time|nohup|exec|command|env)\s+(-\S+\s+)*/, '')
    rest = rest.replace(/^timeout\s+(-\S+\s+)*\S+\s+/, '')
    if (rest === before) break
  }
  return rest
}

function classifyCommand(command: string): BuiltinCategory {
  const segments = command.split(/&&|\|\||;|\n|\|/).map(commandHead).filter(s => s !== '' && !/^cd\b/.test(s))
  if (segments.length === 0) return 'shell'
  if (segments.some(s => BUILD_COMMAND.test(s))) return 'build'
  const first = segments[0] as string
  if (VCS_COMMAND.test(first)) return 'vcs'
  if (segments.some(s => WEB_COMMAND.test(s))) return 'web'
  if (segments.every(s => READ_COMMAND.test(s) || READ_ONLY_SED.test(s))) return 'read'
  return 'shell'
}

const TOOL_CATEGORY: Record<string, BuiltinCategory> = {
  read: 'read', grep: 'read', glob: 'read', lsp: 'read', session_search: 'read', session_trace: 'read',
  session_event_read: 'read', session_event_search: 'read', session_event_trace: 'read',
  list_mcp_resources: 'mcp', list_mcp_resource_templates: 'mcp', read_mcp_resource: 'mcp',
  edit: 'edit', write: 'edit', apply_patch: 'edit', str_replace_editor: 'edit',
  web_fetch: 'web', web_search: 'web',
  read_image: 'vision', office_render: 'vision',
  run_code: 'shell', job_output: 'shell', job_kill: 'shell', job_list: 'shell', pwsh: 'shell',
  terminal_open: 'shell', terminal_send: 'shell', terminal_read: 'shell', terminal_close: 'shell',
  terminal_list: 'shell', terminal_signal: 'shell', user_terminal_list: 'shell', user_terminal_read: 'shell',
  office_convert: 'shell', office_recalculate: 'shell',
  subagent: 'agent', subagent_fork: 'agent', subagent_oar: 'agent', send_message: 'agent', list_agents: 'agent',
  wait_agent: 'agent', interrupt_agent: 'agent', workflow: 'agent', ralph: 'agent', list_subagent_models: 'agent',
  team_task_create: 'agent', team_task_get: 'agent', team_task_list: 'agent', team_task_update: 'agent',
  ask_user_question: 'wait', exit_plan_mode: 'wait', propose_action: 'wait',
}

function builtinCategory(name: string, args: Args): BuiltinCategory {
  if (name.startsWith('mcp__')) return 'mcp'
  if (name === 'bash') return classifyCommand(str(args.command))
  if (name.startsWith('stagehand_') || name.startsWith('cua_') || name.startsWith('browser_') || name.startsWith('computer_')) {
    return 'vision'
  }
  return TOOL_CATEGORY[name] ?? 'other'
}

function firstString(args: Args): string {
  for (const key of Object.keys(args)) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

function describe(name: string, args: Args): string {
  switch (name) {
    case 'bash':
    case 'pwsh':
      return str(args.command) || str(args.description)
    case 'read':
    case 'write':
    case 'edit':
    case 'str_replace_editor':
    case 'read_image':
      return str(args.file_path) || str(args.path) || firstString(args)
    case 'apply_patch': {
      const patch = str(args.patch) || str(args.input)
      const file = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(patch)
      return file?.[1] ?? firstString(args)
    }
    case 'grep':
    case 'glob': {
      const pattern = str(args.pattern)
      const where = str(args.path)
      return where === '' ? pattern : `${pattern}  in ${where}`
    }
    case 'web_fetch':
      return str(args.url)
    case 'web_search':
      return str(args.query)
    case 'run_code':
      return str(args.description) || str(args.code)
    case 'skill':
      return str(args.name)
    case 'subagent':
    case 'subagent_fork':
    case 'subagent_oar':
      return str(args.label) || str(args.description) || str(args.prompt) || str(args.message)
    case 'send_message':
      return [str(args.to) || str(args.agentId), str(args.message) || str(args.content)].filter(Boolean).join(': ')
    case 'job_output':
    case 'job_kill':
      return str(args.jobId) || str(args.job_id) || firstString(args)
    case 'todo_write': {
      const todos = Array.isArray(args.todos) ? args.todos as { content?: unknown; status?: unknown }[] : []
      const active = todos.find(todo => todo?.status === 'in_progress')
      return str(active?.content) || `${todos.length} todos`
    }
    case 'ask_user_question': {
      const questions = Array.isArray(args.questions) ? args.questions as { question?: unknown }[] : []
      return str(questions[0]?.question) || firstString(args)
    }
    default:
      return firstString(args)
  }
}

export interface Classified {
  cat: string
  label: string
}

/** Lane and one-line description for a tool call. */
export function classifyTool(name: string, rawArgs: unknown, rules: readonly CompiledRule[] = []): Classified {
  const args = parseArgs(rawArgs)
  const label = clip(describe(name, args))
  if (rules.length > 0) {
    const subject = `${name} ${label}`
    for (const rule of rules) {
      if (rule.pattern.test(subject)) return { cat: rule.id, label }
    }
  }
  return { cat: builtinCategory(name, args), label }
}

/** Lane for a background job from its label alone (the command line). */
export function classifyJob(kind: string, label: string, rules: readonly CompiledRule[] = []): string {
  const subject = `${kind} ${label}`
  for (const rule of rules) {
    if (rule.pattern.test(subject)) return rule.id
  }
  return kind === 'bash' ? classifyCommand(label) : 'shell'
}

export { clip }
