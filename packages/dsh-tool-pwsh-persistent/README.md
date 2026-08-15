# dsh-tool-pwsh-persistent

A Windows adaptation of `@deepseek-ai/dsh-tool-bash-persistent`: a model-facing
persistent `pwsh` (PowerShell 7) tool over the owner-scoped `ctx.terminals`
registry. One pwsh shell per agent; the current directory, variables,
functions, aliases and activated environments persist across calls.

It pairs with the PTY backend `dsh-terminal-pwsh` (registered
under the `shell` backend type by default).

## Config

| Key | Default | Meaning |
|---|---|---|
| `backendType` | `shell` | Registered PTY backend used for each Agent shell. |
| `timeoutMs` | `300000` | Wall-clock limit for one command; timeout closes the shell. |
| `maxOutputChars` | `16000` | Maximum retained command-output characters. |
| `description` | Persistent-shell description | Model-facing environment contract. |

## Command wrapping contract

Each command runs as `Invoke-Expression` of a backtick-escaped double-quoted
string (multi-line safe, `$` preserved), under `$ErrorActionPreference =
'Stop'` with the previous preference restored afterwards:

- a native command's `$LASTEXITCODE` becomes the reported code;
- otherwise success is `0`, a caught error is `1`;
- explicit `-ErrorAction` overrides and internal `try/catch` behave normally;
- the end marker is emitted on one line: `<end>:<code>`.

## Result contract

Commands share one shell per Agent, so cwd, exported variables, functions and
background jobs persist across calls. Results exclude the controlled prompt.
A nonzero wrapped command appends `[exit code: N]`; a shell that exits before
reporting that status instead appends `[shell exited: code N]` (or the signal
variants), then resets and tells the model that the next call starts fresh.
Long output keeps the earliest retained prefix plus a clipping notice. Timeout
returns bounded partial output, closes the uncertain shell, and reports the
reset.

## Known limitations (Windows)

- No Ctrl-C delivery: a cancelled command runs until the backend deadline,
  then the tool resets the shell.
- PSReadLine echoes the wrapped command line into the terminal; the marker
  protocol slices from the last start marker, so echoed text stays outside the
  reported output.

## Sandbox-mode switches mid-session

The backend (`dsh-terminal-pwsh`) lets a session WIDEN its sandbox
mode (e.g. `read-only` -> `danger-full-access`) while the persistent shell is
open. On a NARROWING switch it closes every owner terminal in the background;
this tool detects the closed session (`NO_SESSION`), resets its cache, spawns a
fresh shell under the new mode, and retries the command once, so the next call
succeeds transparently (shell state is lost, as with any reset).

## Install location

This package is a local addition to the harness install (it is not published).
The canonical source lives under the user preset directory
`~/.dsh/.agent-presets/coding/pwsh-package/`; `install.ps1` there copies it
into BOTH the harness `node_modules` and `~/.dsh/profiles/node_modules` (the
resolution base for preset rows on this deployment). The preset references it
by subpath (`dsh-tool-pwsh-persistent/lib/index.js`) so loading
does not depend on `package.json` entry resolution. Re-run the installer after
a harness upgrade replaces either `node_modules`.
