// Prompt-parity tests: the model-facing prompt surface of the coding preset
// must match the official `minimal` preset except for the bash -> pwsh
// localization, while the auto-escalation contract stays functional:
//   - the persona in agent.cordis.yml is the official minimal persona verbatim
//   - the pwsh tool description is exactly the config value (the official bash
//     description localized); NO escalation paragraph is appended at runtime
//   - the schema still advertises sandbox_permissions / justification
//   - a sandbox denial still renders the marker + same-turn escalation hint,
//     so the model can auto-escalate a denied command without description text
//
// Run: node tests/prompt-parity.mjs  (no PTY needed; uses the fake one-shot shell)
const H = 'C:/Users/Saike/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules'

const toolPkg = await import(`file:///${H}/dsh-tool-pwsh-persistent/lib/index.js`)
const { Context } = await import(`file:///${H}/@deepseek-ai/cordis/lib/index.js`)
const { ToolRuntime } = await import(`file:///${H}/@deepseek-ai/dsh-tools/lib/index.js`)
const { default: SandboxPolicyService } = await import(`file:///${H}/@deepseek-ai/dsh-sandbox-policy/lib/index.js`)
const { default: SystemPrompt } = await import(`file:///${H}/@deepseek-ai/dsh-system-prompt/lib/index.js`)
const { readFileSync } = await import('node:fs')

const OFFICIAL_PERSONA = 'You are a helpful software engineer assistant.'
const LOCALIZED_DESCRIPTION = `Run commands in a pwsh (PowerShell 7) shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to common Windows tooling: PowerShell cmdlets and native executables on PATH.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'Get-Content C:\\path\\to\\file | Select-Object -Skip 9 -First 16'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'Start-Process' or a PowerShell background job.`

const app = new Context()
new SystemPrompt(app, SystemPrompt.Config({ includeHarnessIdentity: false }))
new ToolRuntime(app)
new SandboxPolicyService(app, { mode: 'read-only', workspaceRoot: process.cwd() })
// fake sandbox provider (test env only)
app.provide('sandbox', { confine: (argv) => ({ argv }) })
let shellDenied = false
// fake one-shot shell executor for confined-mode calls
app.provide('shell', {
  sandboxMode: 'read-only',
  resolve: (r) => r,
  run: async (r) => ({
    exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 300000,
    stdout: { text: 'out', truncated: false },
    stderr: { text: '', truncated: false },
    sandbox: { mode: r.sandboxPolicy?.mode, denied: shellDenied },
  }),
})
app.provide('shellEnv', { collect: () => ({ DSH_SHELL: '1' }) })
app.provide('approval', { request: async () => 'allowed-once' })

const listeners = new Map()
const owner = {
  id: 'parity-agent',
  session: {
    header: { cwd: process.cwd() },
    events: [{ type: 'sandbox/mode', data: { mode: 'read-only' } }],
    append: (type, data) => {
      const event = { type, data }
      const listener = listeners.get('internal/dispatch')
      if (listener) listener('parallel', 'session/event', [owner.session, event])
    },
  },
  ctx: {
    effect: (fn) => { fn(); return () => {} },
    on: (name, cb) => { listeners.set(name, cb); return () => listeners.delete(name) },
  },
}
app.provide('agents', { get: (id) => (id === owner.id ? owner : undefined) })

toolPkg.apply(app, toolPkg.Config({ timeoutMs: 60000, maxOutputChars: 16000, description: LOCALIZED_DESCRIPTION }))

const defs = [...app.get('tools').layers.global.tools.values()]
const pwshDef = defs.find((d) => d.name === 'pwsh')
const exec = { agent: owner, signal: new AbortController().signal, callId: 'call-1' }

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name} ${extra}`) }
}

// ---- T1: persona in agent.cordis.yml is the official minimal persona ----
const presetText = readFileSync(new URL('../agent.cordis.yml', import.meta.url), 'utf8')
check('T1 persona matches official minimal', presetText.includes(`text: ${OFFICIAL_PERSONA}`))
check('T1 no leftover custom persona', !presetText.includes('coding engineer assistant'))
check('T1 yml description is the localized text', presetText.includes('Run commands in a pwsh (PowerShell 7) shell') && !presetText.includes('persistent pwsh (PowerShell 7) shell'))

// ---- T2: description is exactly the localized official text, nothing appended ----
check('T2 description is the localized official text', pwshDef.description === LOCALIZED_DESCRIPTION, JSON.stringify(pwshDef.description))
check('T2 no escalation paragraph appended', !pwshDef.description.includes('danger-full-access') && !pwshDef.description.includes('one-shot') && !pwshDef.description.includes('sandbox_permissions'))

// ---- T3: schema still advertises the escalation fields ----
const params = pwshDef.parameters?.properties ?? pwshDef.parameters ?? {}
check('T3 schema has sandbox_permissions', params.sandbox_permissions !== undefined)
check('T3 schema has justification', params.justification !== undefined)

// ---- T4: denial still renders marker + same-turn escalation hint ----
shellDenied = true
const r = await pwshDef.execute({ command: 'Write-Output "x"' }, exec)
check('T4 denial marker rendered', r.includes('[sandbox: file access denied under read-only mode]'), JSON.stringify(r))
check('T4 escalation hint rendered', r.includes('escalation available — retry this exact command once with sandbox_permissions'), JSON.stringify(r))
shellDenied = false

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
await app.dispose?.()
process.exit(fail > 0 ? 1 : 0)
