<h1 align="center">DSH Coding Preset</h1>

<p align="center">
  <strong>English</strong>
  &nbsp;·&nbsp;
  <a href="./README.zh-CN.md">简体中文</a>
</p>

> **⚠️ DEPRECATED**  
> This package is deprecated because DSH official now provides this functionality by default. It is kept for historical reference only.

**DSH Coding Preset** is a Windows-adapted **“coding mode” agent preset** for DeepSeek Harness (DSH) — an exact Windows port of the official **minimal** preset. It keeps the official minimal composition (fixed persona, no context compaction, only `pwsh` + `str_replace_editor`), but replaces the official persistent bash with a **persistent PowerShell 7 (pwsh)** shell.

- PTY backend (`packages/dsh-terminal-pwsh/`): a node-pty/ConPTY persistent pwsh backend, mirroring `@deepseek-ai/dsh-terminal-bash`.
- Model-facing tool (`packages/dsh-tool-pwsh-persistent/`): a persistent pwsh tool, mirroring `@deepseek-ai/dsh-tool-bash-persistent`.
- Preset files (`agent.cordis.yml` / `preset.yml`): mount the two local packages into a DSH `coding` agent preset.

---

## Installation

> **Note:** This package is **deprecated**. Prefer DSH's official built-in coding mode. The commands below are kept for historical reference only.

The preset is published as a single npm package (`@gamegeek-saikel/dsh-coding-preset`). Installing it into a DSH web profile automatically deploys the preset files and the two internal packages via the package `postinstall` script.

> **Prerequisite:** This preset requires **PowerShell 7 (`pwsh`)**, not the built-in Windows PowerShell 5.1 (`powershell.exe`). Please install PowerShell 7 manually from <https://github.com/PowerShell/PowerShell/releases> or run `winget install Microsoft.PowerShell`.

Install into the web profile:

```bash
npx @deepseek-ai/dsh plugin --profile web add @gamegeek-saikel/dsh-coding-preset
```

Start DSH:

```bash
npx @deepseek-ai/dsh web
```

If you already have the DSH CLI installed globally, you can use `dsh` instead of `npx @deepseek-ai/dsh`:

```bash
dsh plugin --profile web add @gamegeek-saikel/dsh-coding-preset
dsh web
```

The package also keeps the original manual deployment path: copy `agent.cordis.yml` / `preset.yml` into `~/.dsh/.agent-presets/coding/`, then run `install.ps1` to copy the two internal packages into `~/.dsh/profiles/node_modules` and the harness `node_modules`.

## Demo / Evaluation

Validated with DeepSeek V4 Pro (`reasoningEffort=max`) on two one-sentence web-app generation tasks. Both sessions used only `pwsh` + `str_replace_editor` and produced complete single-file HTML demos.

| Artifact | Reasoning blocks | we | let's | let me | Visible replies | Tool calls | Duration |
|---|---:|---:|---:|---:|---:|---:|---:|
| `blackhole.html` | 98 | 411 | 383 | 6 | 1 | 102 | ~29 min |
| `mc.html` | 162 | 525 | 539 | 4 | 1 | 167 | ~54 min |

Demo files and session logs: [`demo/`](demo/)  
Full analysis: [`docs/pro-test-evaluation.md`](docs/pro-test-evaluation.md)

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
| Install | `dsh plugin --profile web add @gamegeek-saikel/dsh-coding-preset` |
| Tests | Prompt parity, sandbox escalation, sandbox mode switch |
| Locale | English + Simplified Chinese (preset display follows the DSH Web locale) |
| License | MIT |

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
dsh-coding-preset/
├── agent.cordis.yml              # Root preset composition (manual install)
├── preset.yml                    # Root preset metadata (manual install)
├── cordis.patch.yml              # Web-profile bundle patch (defaults to coding preset; replaces agent-preset UI)
├── presets/coding/               # Auto-installed preset directory shipped in npm package
│   ├── agent.cordis.yml
│   └── preset.yml
├── dsh-coding-preset-client/      # Fork of dsh-client-ui-agent-preset with coding-mode locale support
│   ├── package.json
│   └── lib/
│       ├── client.js             # Browser half: adds coding to the built-in preset locale table
│       └── index.js              # Host plugin stub
├── install.ps1                   # One-shot deployment into the current DSH
├── package.json                  # Single npm package metadata for publishing
├── pnpm-lock.yaml                # Lockfile for npm/GitHub Actions
├── LICENSE                       # MIT License
├── README.md                     # English documentation
├── README.zh-CN.md               # 简体中文文档
├── DEPRECATED.md                 # Deprecation notice (DSH official now provides this)
├── docs/
│   ├── pro-test-evaluation.md    # Pro-mode black-hole / MC evaluation evidence
│   └── pro-test-data.json        # Machine-readable evaluation data
├── demo/
│   ├── blackhole/                # Black-hole demo artifact + session log
│   └── mc/                       # Minecraft-style demo artifact
├── .github/workflows/publish.yml # npm auto-publish on v* tags
├── scripts/
│   ├── analyze-session.mjs       # Session JSONL trajectory fingerprint analyzer
│   ├── check.mjs                 # Syntax check used by pnpm build
│   └── install-preset.mjs        # postinstall: copies preset + internal packages to DSH home
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
