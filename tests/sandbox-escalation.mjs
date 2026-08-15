// Sandbox-escalation tests for the persistent pwsh tool (dual-path):
//  - danger-full-access session  -> persistent PTY shell (state persists)
//  - confined session (read-only / workspace-write) -> one-shot execution via
//    ctx.shell, exactly like the official one-shot pwsh tool (state does NOT
//    persist between calls)
//  - sandbox_permissions + justification resolve through ctx.approval and are
//    stamped onto EXACTLY that one call: the session mode is never changed and
//    a running persistent shell is never touched.
//
// Run: node tests/sandbox-escalation.mjs  (needs danger-full-access to run:
// ConPTY named pipes are denied in confined modes)
const H = 'C:/Users/Saike/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules'

const backendPkg = await import(`file:///${H}/dsh-terminal-pwsh/lib/index.js`)
const toolPkg = await import(`file:///${H}/dsh-tool-pwsh-persistent/lib/index.js`)
const { Context } = await import(`file:///${H}/@deepseek-ai/cordis/lib/index.js`)
const { default: TerminalSessionService } = await import(`file:///${H}/@deepseek-ai/dsh-terminal/lib/index.js`)
const { ToolRuntime } = await import(`file:///${H}/@deepseek-ai/dsh-tools/lib/index.js`)
const { default: SandboxPolicyService } = await import(`file:///${H}/@deepseek-ai/dsh-sandbox-policy/lib/index.js`)
const { default: SystemPrompt } = await import(`file:///${H}/@deepseek-ai/dsh-system-prompt/lib/index.js`)
const { effectiveSandboxMode } = await import(`file:///${H}/@deepseek-ai/dsh-sandbox-policy/lib/index.js`)

const app = new Context()
new TerminalSessionService(app)
new SystemPrompt(app, SystemPrompt.Config({ includeHarnessIdentity: false }))
new ToolRuntime(app)
new SandboxPolicyService(app, { mode: 'read-only', workspaceRoot: process.cwd() })
// fake sandbox provider so confined modes can still spawn PTYs in this test env
app.provide('sandbox', { confine: (argv) => ({ argv }) })

// fake one-shot shell executor (the host's ctx.shell)
let shellDenied = false
let shellDenialStderr = ''
const shellRuns = []
app.provide('shell', {
  sandboxMode: 'read-only',
  resolve: (r) => r,
  run: async (r) => {
    shellRuns.push(r)
    return {
      exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 300000,
      stdout: { text: 'one-shot-out', truncated: false },
      stderr: { text: shellDenialStderr, truncated: false },
      sandbox: { mode: r.sandboxPolicy?.mode, denied: shellDenied },
    }
  },
})
app.provide('shellEnv', { collect: () => ({ DSH_SHELL: '1' }) })

// fake approval service; switchable outcome per test
let approvalOutcome = 'allowed-once'
let approvalRequests = []
app.provide('approval', { request: async (req) => { approvalRequests.push(req); return approvalOutcome } })

const listeners = new Map()
const events = []
const owner = {
  id: 'escalation-agent',
  session: {
    header: { cwd: process.cwd() },
    events,
    append: (type, data) => {
      const event = { type, data }
      const listener = listeners.get('internal/dispatch')
      if (listener) listener('parallel', 'session/event', [owner.session, event])
      events.push(event)
    },
  },
  ctx: {
    effect: (fn) => { fn(); return () => {} },
    on: (name, cb) => { listeners.set(name, cb); return () => listeners.delete(name) },
  },
}
app.provide('agents', { get: (id) => (id === owner.id ? owner : undefined) })

backendPkg.apply(app, backendPkg.Config({}))
toolPkg.apply(app, toolPkg.Config({ timeoutMs: 60000, maxOutputChars: 16000 }))

const defs = [...app.get('tools').layers.global.tools.values()]
const pwshDef = defs.find((d) => d.name === 'pwsh')
const exec = { agent: owner, signal: new AbortController().signal, callId: 'call-1' }
const run = async (command, extra = {}) => pwshDef.execute({ command, ...extra }, exec)
const terminals = app.get('terminals')

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name} ${extra}`) }
}

// ---- T0: schema advertises the escalation fields ----
const params = pwshDef.parameters?.properties ?? pwshDef.parameters ?? {}
check('T0 schema has sandbox_permissions', params.sandbox_permissions !== undefined)
check('T0 schema has justification', params.justification !== undefined)

// ---- T1: confined session -> one-shot path, session mode untouched ----
events.push({ type: 'sandbox/mode', data: { mode: 'read-only' } })
shellDenied = false
shellRuns.length = 0
let r = await run('Write-Output "x"')
check('T1 one-shot result rendered', r === 'one-shot-out', JSON.stringify(r))
check('T1 ran through ctx.shell', shellRuns.length === 1)
check('T1 one-shot policy is the standing mode', shellRuns[0].sandboxPolicy.mode === 'read-only')
check('T1 no PTY spawned', terminals.sessions.size === 0)
check('T1 session mode unchanged', effectiveSandboxMode(events) === 'read-only')

// ---- T2: confined session + escalation -> granted mode stamped onto this call only ----
approvalRequests = []
approvalOutcome = 'allowed-once'
shellRuns.length = 0
r = await run('Write-Output "x"', { sandbox_permissions: 'danger-full-access', justification: 'test: single-call escalation' })
check('T2 escalated one-shot runs', r === 'one-shot-out', JSON.stringify(r))
check('T2 approval was requested with reason', approvalRequests.length === 1 && /escalate sandbox to danger-full-access/.test(approvalRequests[0].reason))
check('T2 granted mode stamped on this call', shellRuns[0].sandboxPolicy.mode === 'danger-full-access')
check('T2 no permission/preset event', !events.some((e) => e.type === 'permission/preset'))
check('T2 no sandbox/mode event appended', events.filter((e) => e.type === 'sandbox/mode').length === 1)
check('T2 session mode unchanged', effectiveSandboxMode(events) === 'read-only')
check('T2 no PTY spawned', terminals.sessions.size === 0)

// ---- T3: sandbox denial renders the marker + escalation hint ----
shellDenied = true
shellRuns.length = 0
r = await run('Write-Output "x"')
check('T3 denial marker rendered', r.includes('[sandbox: file access denied under read-only mode]'), JSON.stringify(r))
check('T3 escalation hint rendered', r.includes('escalation available — retry this exact command once with sandbox_permissions'), JSON.stringify(r))
shellDenied = false

// ---- T3b: Windows ACL denial wording without sandbox.denied still renders the hint ----
shellDenialStderr = "fatal error - couldn't create signal pipe, Win32 error 5"
shellRuns.length = 0
r = await run('git push')
check('T3b stderr denial marker rendered', r.includes('[sandbox: file access denied under read-only mode]'), JSON.stringify(r))
check('T3b stderr escalation hint rendered', r.includes('escalation available — retry this exact command once with sandbox_permissions'), JSON.stringify(r))
shellDenialStderr = ''

// ---- T4: user rejection -> error, nothing ran ----
approvalOutcome = 'rejected'
shellRuns.length = 0
let threw = false
let errMsg = ''
try { await run('Write-Output "x"', { sandbox_permissions: 'danger-full-access', justification: 'test: rejection' }) } catch (e) { threw = true; errMsg = e.message }
check('T4 rejection throws', threw && /rejected/.test(errMsg), errMsg)
check('T4 nothing ran after rejection', shellRuns.length === 0)
check('T4 session mode unchanged after rejection', effectiveSandboxMode(events) === 'read-only')

// ---- T5: non-widening request refused without prompting ----
events.push({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } })
approvalRequests = []
approvalOutcome = 'allowed-once'
threw = false
errMsg = ''
try { await run('Write-Output "x"', { sandbox_permissions: 'danger-full-access', justification: 'test: same mode' }) } catch (e) { threw = true; errMsg = e.message }
check('T5 non-widening throws', threw && /not strictly wider/.test(errMsg), errMsg)
check('T5 no approval prompted', approvalRequests.length === 0)

// ---- T6: missing justification rejected before approval ----
approvalRequests = []
threw = false
try { await run('Write-Output "x"', { sandbox_permissions: 'danger-full-access' }) } catch (e) { threw = true }
check('T6 missing justification throws', threw)
check('T6 no approval prompted without justification', approvalRequests.length === 0)

// ---- T7: danger-full-access session -> persistent PTY path ----
events.push({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } })
shellRuns.length = 0
r = await run('Write-Output "persistent-works"')
check('T7 persistent path executes the command', r === 'persistent-works', JSON.stringify(r))
check('T7 PTY spawned for persistent path', terminals.sessions.size === 1)
check('T7 one-shot not used in danger mode', shellRuns.length === 0)
r = await run('$global:pv = 5; Write-Output "set"')
r = await run('Write-Output "got=$global:pv"')
check('T7 persistent state survives across calls', r === 'got=5', JSON.stringify(r))

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
await app.dispose?.()
process.exit(fail > 0 ? 1 : 0)
