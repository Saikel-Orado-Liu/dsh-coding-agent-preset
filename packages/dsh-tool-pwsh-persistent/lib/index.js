/**
 * Model-facing persistent `pwsh` tool over the owner-scoped PTY seam.
 *
 * A Windows adaptation of `@deepseek-ai/dsh-tool-bash-persistent`: the same
 * per-owner lazy shell, per-command start/end marker protocol, scrollback
 * polling, timeout reset, and shell-exit reset — with a PowerShell dialect.
 *
 * Command wrapping (validated against pwsh 7.6 on Windows):
 * - The command travels as a double-quoted, backtick-escaped string handed to
 *   `Invoke-Expression`, so multi-line commands, `$` interpolation and quotes
 *   inside the command survive while the physical PTY line stays single.
 * - `$ErrorActionPreference` is set to `Stop` around the invocation so a
 *   failing cmdlet reports a nonzero code like bash's `$?` contract; explicit
 *   `-ErrorAction` overrides and internal `try/catch` still behave normally.
 * - A native command's `$LASTEXITCODE` wins; otherwise success is 0 and a
 *   caught error is 1. The end marker is emitted on one line:
 *   `<end>:<code>`.
 * - The shell's prompt function is replaced with a controlled
 *   `__DSH_PERSISTENT_PWSH_PROMPT__ ` so readiness is detectable from the
 *   sanitized text tail.
 *
 * @module @deepseek-ai/dsh-tool-pwsh-persistent
 */
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ESCALATION_TARGETS, approveEscalation, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from "@deepseek-ai/dsh-sandbox";

const TRUNCATED_MESSAGE = "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `Select-String` in order to find the line numbers of what you are looking for.</NOTE>";
const LOST_PREFIX_MESSAGE = "<response clipped><NOTE>The beginning of this command output was dropped by the terminal scrollback limit. The following text is the earliest retained output.</NOTE>\n";
const SHELL_RESET_MESSAGE = "The persistent pwsh shell was reset; the next pwsh call starts from the workspace with a fresh current directory and environment.";
/** The controlled prompt both the backend readiness and this tool rely on. */
const SHELL_PROMPT = "__DSH_PERSISTENT_PWSH_PROMPT__ ";
/** One-line command that replaces the interactive prompt with the controlled one. */
const INIT_COMMAND = "function global:prompt { '__DSH_PERSISTENT_PWSH_PROMPT__ ' }";
const TIMEOUT_CODE = "PERSISTENT_PWSH_TIMEOUT";
const SCROLLBACK_PAGE_LINES = 1e3;
const POLL_INTERVAL_MS = 25;
const DEFAULT_DESCRIPTION = "Run commands in a persistent pwsh (PowerShell 7) shell. State, including the current directory, variables, functions, aliases, and activated environments, persists across calls for this agent.";

function maybeTruncate(content, maxOutputChars, incomplete = false) {
  if (content.length <= maxOutputChars && !incomplete) return content;
  return content.length <= maxOutputChars ? content + TRUNCATED_MESSAGE : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE;
}

function markers() {
  const nonce = randomUUID();
  return {
    start: `__DSH_PERSISTENT_PWSH_START_${nonce}__`,
    end: `__DSH_PERSISTENT_PWSH_END_${nonce}:`
  };
}

/**
 * Quote a command as a PowerShell double-quoted string literal with backtick
 * escapes: backtick, double quote and `$` are escaped so the wrapper cannot
 * interpolate or break out, and CR/LF become `` `r ``/`` `n `` so multi-line
 * commands stay on one physical PTY line while `Invoke-Expression` still
 * receives the real newlines.
 */
function quoteForPwsh(value) {
  return `"${value
    .replaceAll("`", "``")
    .replaceAll('"', '`"')
    .replaceAll("$", "`$")
    .replaceAll("\r", "`r")
    .replaceAll("\n", "`n")}"`;
}

/**
 * Wrap one command with start/end markers and an exit-code report. The
 * `Write-Output ('<end>:' + $code)` parenthesization is required: in argument
 * mode, `Write-Output 'a' + $code` would be parsed as three arguments.
 */
function wrapCommand(command, marker) {
  return `Write-Output '${marker.start}'; $global:LASTEXITCODE = $null; $__dshEap = $ErrorActionPreference; $ErrorActionPreference = 'Stop'; try { Invoke-Expression ${quoteForPwsh(command)}; if ($null -ne $global:LASTEXITCODE) { $code = $global:LASTEXITCODE } else { $code = 0 } } catch { Write-Output $_; $code = 1 } finally { $ErrorActionPreference = $__dshEap }; Write-Output ('${marker.end}' + $code)`;
}

function stripPrompt(text) {
  let result = text.replace(/\r?\n$/, "");
  while (result.endsWith(SHELL_PROMPT)) result = result.slice(0, -SHELL_PROMPT.length);
  return result.endsWith("\n") ? result.slice(0, -1) : result;
}

function commandOutput(snapshot, marker) {
  const text = snapshot.text;
  const end = text.lastIndexOf(marker.end);
  const status = /^(\d+)\r?\n/.exec(text.slice(end + marker.end.length))?.[1];
  if (status === void 0) return void 0;
  const startMarker = text.lastIndexOf(marker.start, end);
  const start = startMarker < 0 ? 0 : startMarker + marker.start.length;
  return {
    text: stripPrompt(text.slice(start, end).replace(/^\r?\n/, "")),
    incomplete: startMarker < 0,
    exitCode: Number(status)
  };
}

function promptCompleted(result) {
  return result.viewport.endsWith(SHELL_PROMPT) || result.viewport.endsWith(`${SHELL_PROMPT}\r\n`) || result.viewport.endsWith(`${SHELL_PROMPT}\n`);
}

function partialOutput(snapshot, marker, fallback, fallbackTruncated = false) {
  const startMarker = snapshot.text.lastIndexOf(marker.start);
  if (startMarker >= 0) return {
    text: stripPrompt(snapshot.text.slice(startMarker + marker.start.length).replace(/^\r?\n/, "")),
    incomplete: false
  };
  const fallbackStart = fallback.lastIndexOf(marker.start);
  const afterStart = fallbackStart < 0 ? fallback : fallback.slice(fallbackStart + marker.start.length).replace(/^\r?\n/, "");
  const fallbackEnd = afterStart.lastIndexOf(marker.end);
  return {
    text: stripPrompt((fallbackEnd < 0 ? afterStart : afterStart.slice(0, fallbackEnd)).replaceAll(SHELL_PROMPT, "")),
    incomplete: fallbackTruncated || fallbackStart < 0
  };
}

async function pause() {
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

function nextScrollbackOffset(page, offset) {
  if (page.text.length === 0 || page.lineEnd <= offset) return void 0;
  return page.lineEnd;
}

function retainedScrollback(ctx, owner, id, latest = ctx.terminals.read(owner, id, { offset: 0, count: SCROLLBACK_PAGE_LINES })) {
  const pages = latest.text.length === 0 ? [] : [latest.text];
  let offset = latest.lineEnd;
  let truncated = latest.truncated;
  while (true) {
    if (offset >= latest.totalLines) break;
    const page = ctx.terminals.read(owner, id, { offset, count: SCROLLBACK_PAGE_LINES });
    truncated ||= page.truncated;
    if (page.text.length > 0) pages.unshift(page.text);
    const next = nextScrollbackOffset(page, offset);
    if (next === void 0 || next >= page.totalLines) break;
    offset = next;
  }
  return { text: pages.join("\n"), truncated };
}

function renderCaptured(output, maxOutputChars) {
  const rendered = maybeTruncate(output.text, maxOutputChars, output.incomplete);
  return appendStatusMarker(output.incomplete && output.text.length > 0 ? LOST_PREFIX_MESSAGE + rendered : rendered, output.exitCode !== void 0 && output.exitCode !== 0 ? `[exit code: ${output.exitCode}]` : void 0);
}

function appendStatusMarker(content, marker) {
  if (marker === void 0) return content;
  return content.length === 0 ? marker : `${content}\n${marker}`;
}

function renderShellExitStatus(content, exitCode, signal) {
  return appendStatusMarker(content, signal !== null ? `[shell killed by signal: ${signal}]` : exitCode !== null ? `[shell exited: code ${exitCode}]` : "[shell exited]");
}

function persistentShells(ctx, config) {
  const pending = /* @__PURE__ */ new WeakMap();
  const live = /* @__PURE__ */ new Map();
  const creating = /* @__PURE__ */ new Set();
  const ownerCleanupInstalled = /* @__PURE__ */ new WeakSet();
  const lifecycle = new AbortController();
  const close = async (owner, id, reason) => {
    if (!ctx.terminals.list(owner).some((snapshot) => snapshot.sessionId === id)) return;
    await ctx.terminals.kill(owner, id, reason);
  };
  ctx.effect(() => async () => {
    lifecycle.abort(/* @__PURE__ */ new Error("tool-pwsh-persistent disposed during shell creation"));
    await Promise.allSettled([...creating]);
    const closing = [...live].map(async ([owner, id]) => {
      await close(owner, id, "tool-pwsh-persistent disposed");
    });
    await Promise.all(closing);
    live.clear();
  }, "tool-pwsh-persistent shell cleanup");
  const reset = async (owner, reason) => {
    pending.delete(owner);
    const id = live.get(owner);
    live.delete(owner);
    if (id !== void 0) await close(owner, id, reason);
  };
  const get = (owner, signal) => {
    const existing = pending.get(owner);
    if (existing !== void 0) return existing;
    const combinedSignal = AbortSignal.any([signal, lifecycle.signal]);
    const tracked = (async () => {
      try {
        const cwd = owner.session.header.cwd;
        const spawned = await ctx.terminals.spawn(owner, {
          type: config.backendType,
          ...cwd === void 0 ? {} : { cwd }
        }, combinedSignal);
        live.set(owner, spawned.sessionId);
        if (!ownerCleanupInstalled.has(owner)) {
          ownerCleanupInstalled.add(owner);
          owner.ctx.effect(() => () => {
            pending.delete(owner);
            live.delete(owner);
          }, "tool-pwsh-persistent owner cache cleanup");
        }
        const result = await ctx.terminals.startSend(owner, spawned.sessionId, {
          text: INIT_COMMAND,
          submit: true,
          signal: combinedSignal
        }).done;
        if (result.sessionStatus.kind === "exited" || result.waitReason === "timeout") throw new Error("persistent pwsh shell did not accept initialization");
        return spawned.sessionId;
      } catch (error) {
        await reset(owner, "persistent pwsh initialization failed");
        throw error;
      }
    })().finally(() => {
      creating.delete(tracked);
    });
    creating.add(tracked);
    pending.set(owner, tracked);
    return tracked;
  };
  return { get, reset };
}

async function executeCommand(ctx, shells, owner, command, config, upstream, retried = false) {
  const env_1 = { stack: [], error: void 0, hasError: false };
  try {
    const commandDeadline = __addDisposableResource(env_1, deadline(upstream, config.timeoutMs, TIMEOUT_CODE), false);
    const id = await shells.get(owner, commandDeadline.signal);
    const marker = markers();
    const wrapped = wrapCommand(command, marker);
    let first = true;
    let fallback = "";
    let fallbackTruncated = false;
    while (true) {
      let operation;
      let result;
      try {
        operation = ctx.terminals.startSend(owner, id, {
          text: first ? wrapped : "",
          submit: first,
          signal: commandDeadline.signal
        });
        first = false;
        result = await operation.done;
      } catch (error) {
        await shells.reset(owner, "persistent pwsh send failed");
        if (error?.code === "NO_SESSION" && !retried) {
          // The shell was closed underneath us (e.g. a sandbox-mode narrowing
          // closed every owner session); spawn a fresh shell and retry once.
          return executeCommand(ctx, shells, owner, command, config, upstream, true);
        }
        throw error;
      }
      const incremental = operation.readOutput();
      fallback = incremental.delta.length > 0 ? fallback + incremental.delta : result.viewport;
      fallbackTruncated ||= incremental.truncated || result.truncated;
      const latest = ctx.terminals.read(owner, id, { offset: 0, count: SCROLLBACK_PAGE_LINES });
      const timedOut = timeoutOf(commandDeadline.signal, TIMEOUT_CODE);
      if (timedOut !== void 0) {
        const partial = renderCaptured(partialOutput(retainedScrollback(ctx, owner, id, latest), marker, fallback, fallbackTruncated), config.maxOutputChars);
        await shells.reset(owner, "persistent pwsh command timed out");
        return [
          `Your command timed out after ${Math.round(timedOut.timeoutMs / 1e3)} seconds or experienced an OOM error. Below is partial output:`,
          partial,
          SHELL_RESET_MESSAGE
        ].join("\n");
      }
      if (commandDeadline.signal.aborted) {
        await shells.reset(owner, "persistent pwsh command aborted");
        commandDeadline.signal.throwIfAborted();
      }
      if (latest.text.includes(marker.end)) {
        const complete = commandOutput(retainedScrollback(ctx, owner, id, latest), marker);
        if (complete !== void 0) return renderCaptured(complete, config.maxOutputChars);
      }
      if (result.sessionStatus.kind === "exited") {
        const snapshot = retainedScrollback(ctx, owner, id, latest);
        await shells.reset(owner, "persistent pwsh shell exited");
        return [renderShellExitStatus(renderCaptured(partialOutput(snapshot, marker, fallback, fallbackTruncated), config.maxOutputChars), result.sessionStatus.exitCode, result.sessionStatus.signal), SHELL_RESET_MESSAGE].filter((part) => part.length > 0).join("\n");
      }
      if (promptCompleted(result)) return renderCaptured(partialOutput(retainedScrollback(ctx, owner, id, latest), marker, fallback, fallbackTruncated), config.maxOutputChars);
      await pause();
    }
  } catch (e_1) {
    env_1.error = e_1;
    env_1.hasError = true;
  } finally {
    __disposeResources(env_1);
  }
}

/**
 * The model-facing prompt surface intentionally mirrors the official `minimal`
 * preset: the tool description carries only the bash -> pwsh localization (no
 * appended escalation paragraph). The escalation contract is driven by the
 * schema (`sandbox_permissions` / `justification` below) and by the runtime
 * denial markers, which already render the same-turn escalation hint, so the
 * model can auto-escalate a denied command without description-level teaching.
 */

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function oneShotStreamText(output) {
  if (!output.truncated) return output.text;
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? "(unavailable)"}]`;
}

/**
 * Windows sandbox/runner denials that the host executor may not classify into
 * `result.sandbox.denied`. The official Windows ACL signatures cover file
 * access wording, but MSYS/Git helper processes can surface the same ACL
 * denial as `Win32 error 5` / `couldn't create signal pipe`; without this
 * fallback the model would see a bare command failure and never receive the
 * same-turn escalation hint.
 */
const WINDOWS_SANDBOX_DENIAL_PATTERNS = [
  /win32 error 5/i,
  /couldn'?t create signal pipe/i,
  /could not create signal pipe/i,
  /cannot create signal pipe/i,
  /\bEPERM\b/i,
  /access is denied/i,
  /access to the path/i,
  /permission denied/i,
  /operation not permitted/i,
  /read-only file system/i,
];

function looksLikeSandboxDenial(result) {
  const stderr = result.stderr?.text ?? "";
  return WINDOWS_SANDBOX_DENIAL_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Shape one finished one-shot run into the text the model sees, mirroring the
 * official one-shot pwsh renderer: stdout, a marked stderr section, sandbox
 * denial markers with the same-turn escalation hint, timeout/signal/exit
 * markers. A clean exit produces no marker.
 */
function renderOneShotResult(result) {
  const out = oneShotStreamText(result.stdout);
  const err = oneShotStreamText(result.stderr);
  let body = out;
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    body += `[stderr]\n${err}`;
  }
  if (body.length === 0) body = "(no output)";
  const markers = [];
  if (result.sandbox?.denied || looksLikeSandboxDenial(result)) {
    markers.push(sandboxDenialMarker(result.sandbox?.mode ?? "unknown"));
    if (ESCALATION_TARGETS.length > 0) markers.push(escalationHintMarker("command"));
  }
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`);
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`);
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`);
  if (markers.length === 0) return body;
  if (!body.endsWith("\n")) body += "\n";
  return body + markers.join("\n");
}

/**
 * Run one command through the host's one-shot shell executor (`ctx.shell`),
 * with the exact policy stamped onto this call. Used when the session is in a
 * confined mode (the persistent PTY shell cannot start) or when an escalation
 * was approved: an escalation never changes the session mode — only this call
 * runs under the granted mode.
 */
async function runOneShot(ctx, owner, command, policy, exec) {
  const shell = ctx.get("shell");
  if (shell === void 0) throw new Error("confined session: one-shot pwsh execution requires the host shell executor (ctx.shell), which is not composed");
  const shellEnv = ctx.get("shellEnv");
  const request = {
    command,
    ...owner.session.header.cwd !== void 0 ? { workdir: owner.session.header.cwd } : {},
    ...shellEnv !== void 0 ? { dshEnv: shellEnv.collect(exec) } : {},
    sandboxPolicy: policy
  };
  const result = await shell.run(shell.resolve({ ...request, signal: exec.signal }));
  if (result.aborted) throw new Error("tool call aborted");
  return renderOneShotResult(result);
}

/**
 * Register the model-facing persistent `pwsh` tool.
 * @param ctx - plugin context carrying tools, the owner-scoped PTY service, and sandbox policy.
 * @param config - selected PTY backend and command deadline.
 */
function registerPersistentPwsh(ctx, config) {
  const shells = persistentShells(ctx, config);
  const queues = /* @__PURE__ */ new WeakMap();
  const serialized = async (owner, operation) => {
    const run = (queues.get(owner) ?? Promise.resolve()).then(operation, operation);
    const tail = run.then(() => void 0, () => void 0);
    queues.set(owner, tail);
    try {
      return await run;
    } finally {
      if (queues.get(owner) === tail) queues.delete(owner);
    }
  };
  /**
   * Resolve an escalation request through `ctx.approval` BEFORE anything runs,
   * delegating the shared fail-closed sequence (strict widening, channel
   * resolution, outcome mapping) to {@link approveEscalation}. The granted
   * mode is returned and stamped onto exactly this one call — the session
   * mode is never changed, and a running persistent shell (danger-full-access
   * sessions) is never touched.
   */
  const approveOneShotEscalation = (mode, justification, exec, standingPolicy) => approveEscalation({
    requestedMode: mode,
    justification,
    effectiveMode: standingPolicy.mode,
    subject: "command"
  }, {
    approver: ctx.get("approval"),
    agent: exec.agent,
    callId: exec.callId,
    toolName: "pwsh",
    signal: exec.signal
  });
  ctx.tools.register(defineTool({
    name: "pwsh",
    description: config.description,
    parameters: { command: {
      type: "string",
      required: true,
      description: "The pwsh (PowerShell 7) command to run. Relative path is preferred in the command."
    }, ...ESCALATION_TARGETS.length > 0 ? {
      sandbox_permissions: {
        type: "string",
        enum: [...ESCALATION_TARGETS],
        description: "The wider sandbox mode this command needs. Only valid as a retry of a command the sandbox just denied; requires justification and user approval. The escalation applies to this single call only and never changes the session mode."
      },
      justification: {
        type: "string",
        description: "Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access."
      }
    } : {} },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    async execute(args, exec) {
      if (args.command.trim().length === 0) throw new Error("command must be a non-empty string");
      const owner = exec.agent;
      if (owner === void 0) throw new Error("pwsh requires an owning agent session");
      validateEscalationArgs(args.sandbox_permissions, args.justification);
      const standingPolicy = ctx.sandboxPolicy.resolve({ session: owner.session });
      const approvedMode = args.sandbox_permissions !== void 0
        ? await approveOneShotEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
        : void 0;
      // One-shot path: confined session (the persistent PTY shell cannot
      // start — ConPTY named pipes are denied), or an escalated call (the
      // granted mode is stamped onto exactly this call; the session mode is
      // unchanged and the persistent shell, when running, is untouched).
      if (standingPolicy.mode !== "danger-full-access" || approvedMode !== void 0) {
        return runOneShot(ctx, owner, args.command, {
          ...standingPolicy,
          mode: approvedMode ?? standingPolicy.mode
        }, exec);
      }
      // Persistent path: danger-full-access, no escalation.
      return serialized(owner, async () => {
        exec.signal.throwIfAborted();
        return executeCommand(ctx, shells, owner, args.command, config, exec.signal);
      });
    },
    presentCall: (args) => ({ card: "terminal", title: args.command })
  }));
}

const name = "tool-pwsh-persistent";
const inject = ["tools", "terminals", "sandboxPolicy"];
/** Runtime configuration schema for the persistent pwsh tool. */
const Config = z.object({
  backendType: z.string().default("shell"),
  timeoutMs: z.number().default(3e5),
  maxOutputChars: z.number().default(16e3),
  description: z.string().default(DEFAULT_DESCRIPTION)
});

/** Register one owner-scoped persistent `pwsh` tool. */
function apply(ctx, config) {
  const resolved = {
    backendType: config.backendType ?? "shell",
    timeoutMs: config.timeoutMs ?? 3e5,
    maxOutputChars: config.maxOutputChars ?? 16e3,
    description: config.description ?? DEFAULT_DESCRIPTION
  };
  if (resolved.backendType.trim().length === 0) throw new Error("tool-pwsh-persistent: backendType must be non-empty");
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0) throw new Error("tool-pwsh-persistent: timeoutMs must be a positive safe integer");
  if (!Number.isSafeInteger(resolved.maxOutputChars) || resolved.maxOutputChars <= 0) throw new Error("tool-pwsh-persistent: maxOutputChars must be a positive safe integer");
  if (resolved.description.trim().length === 0) throw new Error("tool-pwsh-persistent: description must be non-empty");
  if (ctx.get("sandboxPolicy") === void 0) throw new Error("tool-pwsh-persistent: sandboxPolicy service is required");
  registerPersistentPwsh(ctx, resolved);
}

//#region __addDisposableResource / __disposeResources (compiled from TS, as in the official package)
var __addDisposableResource = function(env, value, async) {
  if (value !== null && value !== void 0) {
    if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
    var dispose, inner;
    if (async) {
      if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
      dispose = value[Symbol.asyncDispose];
    }
    if (dispose === void 0) {
      if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
      dispose = value[Symbol.dispose];
      if (async) inner = dispose;
    }
    if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
    if (inner) dispose = function() {
      try {
        inner.call(this);
      } catch (e) {
        return Promise.reject(e);
      }
    };
    env.stack.push({ value, dispose, async });
  } else if (async) env.stack.push({ async: true });
  return value;
};
var __disposeResources = (function(SuppressedError) {
  return function(env) {
    function fail(e) {
      env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
      env.hasError = true;
    }
    var r, s = 0;
    function next() {
      while (r = env.stack.pop()) try {
        if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
        if (r.dispose) {
          var result = r.dispose.call(r.value);
          if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
            fail(e);
            return next();
          });
        } else s |= 1;
      } catch (e) {
        fail(e);
      }
      if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
      if (env.hasError) throw env.error;
    }
    return next();
  };
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
  var e = new Error(message);
  return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
//#endregion

export { Config, apply, inject, name };
