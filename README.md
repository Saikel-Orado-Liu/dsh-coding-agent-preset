<h1 align="center">DSH Coding Agent Preset</h1>

<p align="center">
  <strong>English</strong>
  &nbsp;·&nbsp;
  <a href="./README.zh-CN.md">简体中文</a>
</p>

**DSH Coding Agent Preset** is a Windows-adapted **“coding mode” agent preset** for DeepSeek Harness (DSH) — an exact Windows port of the official **minimal** preset. It keeps the official minimal composition (fixed persona, no context compaction, only `pwsh` + `str_replace_editor`), but replaces the official persistent bash with a **persistent PowerShell 7 (pwsh)** shell.

- PTY backend (`packages/dsh-terminal-pwsh/`): a node-pty/ConPTY persistent pwsh backend, mirroring `@deepseek-ai/dsh-terminal-bash`.
- Model-facing tool (`packages/dsh-tool-pwsh-persistent/`): a persistent pwsh tool, mirroring `@deepseek-ai/dsh-tool-bash-persistent`.
- Preset files (`agent.cordis.yml` / `preset.yml`): mount the two local packages into a DSH `coding` agent preset.

---

## Overview

The official persistent bash backend cannot run on Windows (its subprocess terminal inspection is Linux/macOS-only), and the official `dsh-tool-pwsh` is not persistent (every command starts a fresh `pwsh -Command`). This project therefore provides a Windows-native persistent pwsh stack with the same three-layer architecture as the official persistent bash:

1. **PTY registry** — reuse the official `@deepseek-ai/dsh-terminal` service, scoped to an agent-owned `terminals` realm.
2. **Backend** — `dsh-terminal-pwsh` spawns pwsh directly through node-pty/ConPTY, detects readiness with a controlled prompt, and cleans up the process tree with `taskkill`.
3. **Tool** — `dsh-tool-pwsh-persistent` implements the same start/end marker protocol and PowerShell command wrapping, so state (cwd, variables, functions, aliases, activated environments) persists across calls.

## Key Properties

| Property | Value |
|---|---|
| Scope | Windows-adapted copy of the official `minimal` coding preset |
| Shell | Persistent PowerShell 7 (`pwsh`) via node-pty/ConPTY |
| Tools | `pwsh` + `str_replace_editor` only |
| Persona | Official minimal persona verbatim: `You are a helpful software engineer assistant.` |
| Command wrapping | `Invoke-Expression` + backtick-escaped double-quoted string; `$ErrorActionPreference = 'Stop'` |
| Readiness detection | Controlled prompt `__DSH_PERSISTENT_PWSH_PROMPT__ ` + silence/timeout fallbacks |
| Sandbox modes | `danger-full-access` → persistent PTY shell; confined modes → one-shot pwsh execution |
| Escalation | Single-call `sandbox_permissions` + `justification` via `ctx.approval`; fail-closed |
| Mode switching | Any effective sandbox-mode change closes persistent terminals; next call respawns under the new mode |
| Install | `install.ps1` copies two packages into harness `node_modules` and `~/.dsh/profiles/node_modules` |
| Tests | Prompt parity, sandbox escalation, sandbox mode switch |
| Locale | English + Simplified Chinese |
| License | MIT |

## Installation

The preset is published as a single npm package (`@gamegeek-saikel/dsh-coding-agent-preset`) that contains the preset files and the two internal packages. It is installed as a DSH user preset plus two local packages.

1. Put the preset files into the DSH user preset directory:

   ```powershell
   New-Item -ItemType Directory -Force "$HOME\.dsh\.agent-presets\coding"
   Copy-Item agent.cordis.yml, preset.yml "$HOME\.dsh\.agent-presets\coding\"
   ```

2. Deploy the two self-developed packages (required; preset rows reference them by subpath):

   ```powershell
   .\install.ps1
   ```

3. Create a new **“coding mode”** session in the DSH Web GUI.

`install.ps1` copies `packages/` into two locations:

- the harness `node_modules` (the current npx cache directory; it may be rebuilt on DSH upgrades)
- `~/.dsh/profiles/node_modules` (the resolution base for preset rows)

After a DSH upgrade, rerun `install.ps1` to restore the packages.

## Usage

Once installed and restarted, a coding-mode session exposes exactly two tools: `pwsh` and `str_replace_editor`.

- **Persistent path** (`danger-full-access`): commands run in a shared persistent pwsh PTY. Variables, functions, aliases, and the current directory survive across calls.
- **Confined path** (`read-only` / `workspace-write`): commands run as one-shot `pwsh -Command` executions, matching the official non-persistent `dsh-tool-pwsh` behavior. State does not persist.
- **Sandbox escalation**: if a confined command is denied, the output includes `[sandbox: file access denied ...]` and `escalation available — retry this exact command once with sandbox_permissions`. Retry with `sandbox_permissions` and `justification` to request a one-time approval; the granted mode applies only to that single call and never changes the session mode.

Quick verification:

```powershell
Write-Output "hello"
```

then run a second command that reads a variable set by the first command to confirm persistence in a `danger-full-access` session.

## Architecture

| Layer | Official (bash, Linux/macOS) | This project (pwsh, Windows) |
|---|---|---|
| PTY registry | `@deepseek-ai/dsh-terminal` (`terminals` service) | Same official service, `isolate: terminals` private realm |
| Backend | `dsh-terminal-bash` (subprocess + Linux process inspector) | `dsh-terminal-pwsh`: node-pty/ConPTY, controlled-prompt readiness, `taskkill` tree cleanup |
| Tool | `dsh-tool-bash-persistent` (start/end marker protocol) | `dsh-tool-pwsh-persistent`: same protocol + PowerShell dialect wrapper |

Key implementation points:

- **Command wrapping** — `Invoke-Expression` + backtick-escaped double-quoted string; multi-line commands, `$` interpolation, and quotes survive safely.
- **Exit-code semantics** — `$ErrorActionPreference = 'Stop'` makes failing cmdlets report nonzero like bash; `try/catch` and explicit `-ErrorAction` still work normally.
- **Ready detection** — PowerShell/PSReadLine strip OSC 133 prompt markers, so readiness matches the controlled prompt text tail with silence/timeout fallbacks.
- **Lifecycle** — timeout closes and resets the shell; `exit` detection resets it; owner-level cache and serialized command queue match the official design.
- **Dual-path execution** — `danger-full-access` uses the persistent PTY shell; confined modes use one-shot execution.
- **Single-call escalation** — `sandbox_permissions` + `justification` resolve through `ctx.approval`; rejection, non-widening requests, missing justification, or missing approval service all fail closed.
- **Sandbox-mode switches** — any effective mode change closes persistent terminals in the background; the next call transparently rebuilds the shell under the new mode.
- **Prompt parity** — the persona and tool description stay aligned with official minimal; no escalation paragraph is appended at runtime.

## Project Structure

```
dsh-coding-agent-preset/
├── agent.cordis.yml              # Preset composition (mounts to ~/.dsh/.agent-presets/coding/)
├── preset.yml                    # Preset metadata (name: coding mode)
├── install.ps1                   # One-shot deployment into the current DSH
├── package.json                  # Single npm package metadata for publishing
├── pnpm-lock.yaml                # Lockfile for npm/GitHub Actions
├── LICENSE                       # MIT License
├── README.md                     # English documentation
├── README.zh-CN.md               # 简体中文文档
├── .github/workflows/publish.yml # npm auto-publish on v* tags
├── scripts/
│   └── check.mjs                 # Syntax check used by pnpm build
├── packages/
│   ├── dsh-terminal-pwsh/        # PTY backend package (node-pty/ConPTY)
│   │   └── lib/index.js
│   └── dsh-tool-pwsh-persistent/ # Model-facing persistent pwsh tool
│       └── lib/index.js
└── tests/
    ├── prompt-parity.mjs         # Prompt-surface parity (no PTY needed)
    ├── sandbox-escalation.mjs    # Escalation / dual-path behavior
    └── sandbox-mode-switch.mjs   # Sandbox-mode switch behavior
```

## Development & Testing

The repository root has a package.json for npm packaging; there is no runtime build step. `pnpm build` runs syntax checks over the package and test JS files. The tests themselves are plain Node scripts that import from the installed DSH harness `node_modules`.

```bash
node tests/prompt-parity.mjs
```

`prompt-parity.mjs` does not need a PTY and can run in confined mode. The other two suites spawn real ConPTY pwsh sessions and therefore require `danger-full-access`:

```bash
node tests/sandbox-escalation.mjs
node tests/sandbox-mode-switch.mjs
```

Run `install.ps1` first so the two packages are present in the harness `node_modules` path used by the tests.

## Documentation

- [`packages/dsh-terminal-pwsh/README.md`](packages/dsh-terminal-pwsh/README.md) — backend design and configuration
- [`packages/dsh-tool-pwsh-persistent/README.md`](packages/dsh-tool-pwsh-persistent/README.md) — tool contract and known Windows limitations
- [`README.zh-CN.md`](README.zh-CN.md) — 简体中文版本

## License

This repository (source, tests, README, and the DSH preset shape) is licensed under the **MIT License** — see [`LICENSE`](LICENSE).

Copyright (c) 2026 Saikel-Orado-Liu aka GameGeek-Saikel
