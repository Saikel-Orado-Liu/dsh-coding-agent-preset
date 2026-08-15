# dsh-terminal-pwsh

A Windows adaptation of `@deepseek-ai/dsh-terminal-bash`: a persistent pwsh
(PowerShell 7) PTY backend registered into the owner-scoped `ctx.terminals`
registry. It is consumed by the model-facing `pwsh` tool from
`dsh-tool-pwsh-persistent`.

## Why not the official bash backend on Windows?

`@deepseek-ai/dsh-terminal-bash` spawns through `ctx.subprocess.spawnTerminal`,
whose process inspector is Linux/macOS-only (`createProcessInspector` throws on
`win32`). This backend spawns pwsh directly through node-pty (ConPTY on
Windows) and detects readiness without process-group inspection.

## Deviations from `dsh-terminal-bash`

- No OSC 133;D prompt marker (PowerShell/PSReadLine strip it from the prompt
  string); readiness matches the sanitized text tail against the controlled
  prompt `dsh> `, with silence and absolute-timeout fallbacks.
- No process-group stdin-wait inspection; sends settle on prompt evidence +
  idle, inferred-idle silence, or the backend timeout.
- No SIGINT delivery; tool cancellation recovers through its deadline and
  shell reset.
- Teardown force-terminates the pwsh process tree with `taskkill /T /F`.
- `shellPath` defaults to resolving `pwsh` from PATH (node-pty requires an
  absolute executable path on Windows).
- **danger-full-access required**: ConPTY opens `\\.\pipe\conpty-*` named
  pipes, which the Windows sandbox denies in `read-only`/`workspace-write`
  modes; a spawn under a confined mode fails with an actionable error.
- **Any sandbox-mode change rebuilds the shell**: ACLs of a running process
  cannot be changed, so an effective mode switch closes every owner session in
  the background and the tool respawns under the new mode on the next call.

## Config

| Key | Default | Meaning |
|---|---|---|
| `backendType` | `shell` | Registered PTY backend type. |
| `shellPath` | `""` | Absolute pwsh.exe path; empty resolves `pwsh` from PATH. |
| `shellArgs` | `["-NoLogo","-NoProfile"]` | Spawn arguments. |
| `rows` / `cols` | `40` / `160` | ConPTY geometry. |
| `scrollbackLines` | `10000` | Retained line bound. |
| `scrollbackMaxBytes` | `4 MiB` | Retained byte bound. |
| `maxReadBytes` | `256 KiB` | Per-send retained output bound. |
| `pollIntervalMs` | `50` | Readiness poll cadence. |
| `idleSilenceMs` | `3000` | Inferred-idle silence bound. |
| `handoffGraceMs` | `500` | Extra grace after prompt evidence. |
| `timeoutMs` | `30000` | Absolute send/startup bound. |
| `disposeGraceMs` | `3000` | Kill-to-taskkill teardown grace. |

## Install location

This package is a local addition to the harness install (it is not published).
The canonical source lives under the user preset directory
`~/.dsh/.agent-presets/coding/pwsh-package/`; `install.ps1` there copies it
into BOTH the harness `node_modules` and `~/.dsh/profiles/node_modules` (the
resolution base for preset rows on this deployment). The preset references it
by subpath (`dsh-terminal-pwsh/lib/index.js`) so loading does not
depend on `package.json` entry resolution. Re-run the installer after a
harness upgrade replaces either `node_modules`.
