// Sandbox-mode switch tests for the persistent pwsh stack (dual-path).
// Any effective mode change closes the owner's persistent terminals (the
// shell's ACL is fixed at spawn and cannot be widened); the next call
// transparently respawns under the new mode. In confined modes the tool runs
// one-shot via ctx.shell instead of a PTY.
//
// Run: node tests/sandbox-mode-switch.mjs  (needs danger-full-access to run:
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
new SandboxPolicyService(app, { mode: 'danger-full-access', workspaceRoot: process.cwd() })
// fake sandbox provider so confined modes can still spawn in this test env
app.provide('sandbox', { confine: (argv) => ({ argv }) })
// fake one-shot shell executor for confined-mode calls
app.provide('shell', {
  sandboxMode: 'read-only',
  resolve: (r) => r,
  run: async (r) => ({
    exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 300000,
    stdout: { text: `one-shot(${r.sandboxPolicy?.mode})`, truncated: false },
    stderr: { text: '', truncated: false },
    sandbox: { mode: r.sandboxPolicy?.mode, denied: false },
  }),
})
app.provide('shellEnv', { collect: () => ({ DSH_SHELL: '1' }) })

const listeners = new Map()
const events = []
const owner = {
  id: 'mode-test-agent',
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
const run = async (command) => pwshDef.execute({ command }, exec)
const terminals = app.get('terminals')
const waitSessionsClosed = async (timeoutMs = 10000) => {
  const until = Date.now() + timeoutMs
  while (terminals.sessions.size > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
  return terminals.sessions.size === 0
}

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name} ${extra}`) }
}

// ---- T1: narrowing (danger -> read-only) closes the persistent terminal ----
let r = await run('Write-Output "pre-narrow"')
check('T1 persistent shell works under danger', r === 'pre-narrow', JSON.stringify(r))
check('T1 has live session before switch', terminals.sessions.size === 1)
let threw = false
try {
  owner.session.append('sandbox/mode', { mode: 'read-only' })
} catch (e) { threw = true }
check('T1 narrowing does not throw', !threw)
check('T1 terminals closed after narrowing', await waitSessionsClosed())
check('T1 session mode now read-only', effectiveSandboxMode(events) === 'read-only')
r = await run('Write-Output "post-narrow"')
check('T1 confined call runs one-shot', r === 'one-shot(read-only)', JSON.stringify(r))

// ---- T2: widening (read-only -> danger) restores the persistent shell ----
threw = false
try {
  owner.session.append('sandbox/mode', { mode: 'danger-full-access' })
} catch (e) { threw = true }
check('T2 widening does not throw', !threw)
r = await run('Write-Output "post-widen"')
check('T2 persistent shell respawns under danger', r === 'post-widen', JSON.stringify(r))
check('T2 fresh PTY exists', terminals.sessions.size === 1)

// ---- T3: same-mode change is a no-op ----
threw = false
try {
  owner.session.append('sandbox/mode', { mode: 'danger-full-access' })
} catch (e) { threw = true }
check('T3 same-mode does not throw', !threw)
check('T3 session kept on same-mode', terminals.sessions.size === 1)
r = await run('Write-Output "after-same"')
check('T3 shell still usable', r === 'after-same', JSON.stringify(r))

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
await app.dispose?.()
process.exit(fail > 0 ? 1 : 0)
