/**
 * Persistent pwsh (PowerShell 7) PTY backend over node-pty for Windows.
 *
 * A Windows adaptation of `@deepseek-ai/dsh-terminal-bash`, mirroring its
 * architecture: a backend registered into the owner-scoped `terminals`
 * registry, a bounded scrollback, a controlled prompt for readiness, and the
 * same silence/timeout fallbacks. The official bash backend cannot run on
 * Windows because its subprocess seam's terminal inspection is Linux/macOS
 * only (`createProcessInspector` throws on win32), so this backend spawns
 * node-pty directly (ConPTY on Windows) and detects readiness by the
 * controlled prompt text instead of process-group stdin-wait.
 *
 * Known Windows deviations from the official bash backend:
 * - No OSC 133;D prompt marker: PowerShell/PSReadLine strip it from the
 *   prompt string, so readiness matches the sanitized text tail against the
 *   controlled prompt `__DSH_PERSISTENT_PWSH_PROMPT__ ` instead (plus silence
 *   and timeout fallbacks).
 * - No process-group inspection: sends settle on prompt evidence + idle,
 *   inferred-idle silence, or the absolute timeout.
 * - No SIGINT delivery: cancellation marks the operation and the tool's own
 *   deadline/reset path recovers; a bare interruption cannot interrupt a
 *   running foreground command.
 * - Cleanup force-terminates the pwsh process tree with taskkill /T /F.
 *
 * @module @deepseek-ai/dsh-terminal-pwsh
 */
import { TerminalBackendCleanupError, TerminalError } from "@deepseek-ai/dsh-terminal";
import { effectiveSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import z from "@deepseek-ai/schemastery";
import * as nodePty from "node-pty";
import { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter as pathDelimiter, extname, join } from "node:path";
import { constants as osConstants } from "node:os";

/** Validated configuration for the local pwsh PTY backend. */
const Config = z.object({
  backendType: z.string().default("shell"),
  /** Absolute pwsh executable path; empty resolves `pwsh` from PATH. */
  shellPath: z.string().default(""),
  shellArgs: z.array(z.string()).default(["-NoLogo", "-NoProfile"]),
  rows: z.number().default(40),
  cols: z.number().default(160),
  scrollbackLines: z.number().default(1e4),
  scrollbackMaxBytes: z.number().default(4 * 1024 * 1024),
  maxReadBytes: z.number().default(256 * 1024),
  pollIntervalMs: z.number().default(50),
  exactProbeAfterMs: z.number().default(150),
  idleSilenceMs: z.number().default(3e3),
  handoffGraceMs: z.number().default(500),
  timeoutMs: z.number().default(3e4),
  disposeGraceMs: z.number().default(3e3)
});

/** Assert every numeric config field is a positive safe integer and bounds compose. */
function validateConfig(config) {
  const resolved = config;
  if (resolved.backendType.length === 0) throw new Error("terminal-pwsh: backendType must be non-empty");
  for (const [name, value] of Object.entries(resolved)) if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`terminal-pwsh: ${name} must be a positive safe integer`);
  if (resolved.maxReadBytes > resolved.scrollbackMaxBytes) throw new Error("terminal-pwsh: maxReadBytes must not exceed scrollbackMaxBytes");
  if (resolved.handoffGraceMs < resolved.pollIntervalMs) throw new Error("terminal-pwsh: handoffGraceMs must be at least pollIntervalMs so one readiness poll runs inside the grace window");
}

/** Exact printable prompt the session treats as readiness evidence. */
const CONTROLLED_PROMPT = "__DSH_PERSISTENT_PWSH_PROMPT__ ";

/**
 * Remove CSI/OSC/short escape sequences while preserving split-sequence carry.
 * Ported verbatim from `dsh-terminal-bash`; PowerShell renders the same
 * terminal output vocabulary (PSReadLine cursor moves, SGR colors, OSC title).
 */
var TerminalSanitizer = class {
  maxPendingBytes;
  pending = "";
  discardMode;
  discardOscEscape = false;
  trailingCarriageReturn = false;
  trackingPromptTail = false;
  constructor(maxPendingBytes) {
    this.maxPendingBytes = maxPendingBytes;
  }
  push(chunk) {
    this.pending += this.discardPrefix(chunk);
    let text = "";
    let prompt = false;
    let includePromptTail = this.trackingPromptTail;
    let promptTail = "";
    let index = 0;
    const appendText = (value) => {
      text += value;
      if (this.trackingPromptTail) promptTail += value;
    };
    while (index < this.pending.length) {
      const escape = this.pending.indexOf("\x1B", index);
      if (escape < 0) {
        appendText(this.pending.slice(index));
        index = this.pending.length;
        break;
      }
      appendText(this.pending.slice(index, escape));
      if (escape + 1 >= this.pending.length) {
        index = escape;
        break;
      }
      const kind = this.pending[escape + 1];
      if (kind === "]") {
        const bel = this.pending.indexOf("\x07", escape + 2);
        const stringTerminator = this.pending.indexOf("\x1B\\", escape + 2);
        let end = -1;
        if (bel >= 0 && stringTerminator >= 0) end = Math.min(bel + 1, stringTerminator + 2);
        else if (bel >= 0) end = bel + 1;
        else if (stringTerminator >= 0) end = stringTerminator + 2;
        if (end < 0) {
          index = escape;
          break;
        }
        const terminatorBytes = this.pending[end - 1] === "\x07" ? 1 : 2;
        if (this.pending.slice(escape + 2, end - terminatorBytes).startsWith("133;D;")) {
          prompt = true;
          this.trackingPromptTail = true;
          includePromptTail = true;
          promptTail = "";
        }
        index = end;
        continue;
      }
      if (kind === "[") {
        let end = escape + 2;
        while (end < this.pending.length) {
          const code = this.pending.charCodeAt(end);
          if (code >= 64 && code <= 126) break;
          end += 1;
        }
        if (end >= this.pending.length) {
          index = escape;
          break;
        }
        index = end + 1;
        continue;
      }
      index = escape + 2;
    }
    this.pending = this.pending.slice(index);
    this.enforcePendingBound();
    return {
      text: this.normalizeText(text),
      prompt,
      ...includePromptTail ? { promptTail } : {}
    };
  }
  flush() {
    const text = this.pending.startsWith("\x1B") ? "" : this.pending;
    this.pending = "";
    this.discardMode = void 0;
    this.discardOscEscape = false;
    this.trackingPromptTail = false;
    const normalized = this.normalizeText(text);
    if (!this.trailingCarriageReturn) return normalized;
    this.trailingCarriageReturn = false;
    return `${normalized}\n`;
  }
  normalizeText(text) {
    let complete = this.trailingCarriageReturn ? `\r${text}` : text;
    this.trailingCarriageReturn = false;
    if (complete.endsWith("\r")) {
      complete = complete.slice(0, -1);
      this.trailingCarriageReturn = true;
    }
    return normalizeTerminalText(complete);
  }
  enforcePendingBound() {
    if (Buffer.byteLength(this.pending) <= this.maxPendingBytes) return;
    this.discardMode = this.pending[1] === "]" ? "osc" : "csi";
    this.pending = "";
  }
  discardPrefix(chunk) {
    if (this.discardMode === void 0) return chunk;
    if (this.discardMode === "csi") {
      for (let index = 0; index < chunk.length; index += 1) {
        const code = chunk.charCodeAt(index);
        if (code >= 64 && code <= 126) {
          this.discardMode = void 0;
          return chunk.slice(index + 1);
        }
      }
      return "";
    }
    let index = 0;
    if (this.discardOscEscape) {
      this.discardOscEscape = false;
      if (chunk.startsWith("\\")) {
        this.discardMode = void 0;
        return chunk.slice(1);
      }
    }
    while (index < chunk.length) {
      if (chunk[index] === "\x07") {
        this.discardMode = void 0;
        return chunk.slice(index + 1);
      }
      if (chunk[index] === "\x1B") {
        if (chunk[index + 1] === "\\") {
          this.discardMode = void 0;
          return chunk.slice(index + 2);
        }
        if (index + 1 === chunk.length) this.discardOscEscape = true;
      }
      index += 1;
    }
    return "";
  }
};

/** Normalize CRLF and standalone carriage returns for line-oriented rendering. */
function normalizeTerminalText(text) {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\x07", "");
}

/** Persistent PTY session over the node-pty terminal primitive. */
function utf8Tail(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const chars = Array.from(text);
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1]);
    if (bytes + next > maxBytes) break;
    bytes += next;
    start -= 1;
  }
  return { text: chars.slice(start).join(""), truncated: true };
}

var BoundedTextBuffer = class {
  maxBytes;
  maxLines;
  value = "";
  dropped = false;
  constructor(maxBytes, maxLines) {
    this.maxBytes = maxBytes;
    this.maxLines = maxLines;
  }
  append(text) {
    if (text.length === 0) return;
    this.value += text;
    if (this.maxLines !== void 0) {
      const lines = this.value.split("\n");
      if (lines.length > this.maxLines) {
        this.value = lines.slice(lines.length - this.maxLines).join("\n");
        this.dropped = true;
      }
    }
    const tail = utf8Tail(this.value, this.maxBytes);
    this.value = tail.text;
    this.dropped ||= tail.truncated;
  }
  consume() {
    const delta = this.value;
    const truncated = this.dropped;
    this.value = "";
    this.dropped = false;
    return { delta, truncated };
  }
  snapshot() {
    return { text: this.value, truncated: this.dropped };
  }
};

var LocalSendOperation = class {
  startedAt;
  onCancel;
  output;
  promise;
  finished = false;
  cancellationRequested = false;
  constructor(maxBytes, startedAt, onCancel) {
    this.startedAt = startedAt;
    this.onCancel = onCancel;
    this.output = new BoundedTextBuffer(maxBytes);
    this.promise = Promise.withResolvers();
  }
  get done() { return this.promise.promise; }
  get settled() { return this.finished; }
  get cancelRequested() { return this.cancellationRequested; }
  append(text) { if (!this.finished) this.output.append(text); }
  settle(waitReason, sessionStatus, inheritedTruncation) {
    if (this.finished) return;
    this.finished = true;
    const read = this.output.snapshot();
    this.promise.resolve({ viewport: read.text, waitReason, sessionStatus, truncated: read.truncated || inheritedTruncation });
  }
  fail(error) {
    if (this.finished) return;
    this.finished = true;
    this.promise.reject(error);
  }
  readOutput() { return this.output.consume(); }
  cancel() {
    if (this.finished) return false;
    this.cancellationRequested = true;
    this.onCancel();
    return true;
  }
};

function signalName(number) {
  if (number === void 0 || number === 0) return null;
  for (const [name, value] of Object.entries(osConstants.signals)) if (value === number) return name;
  return null;
}

/**
 * Terminate one Windows process tree with `taskkill /T /F`. Mirrors the
 * subprocess seam's teardown for process trees spawned under pwsh (native
 * executables inherit the ConPTY session and may outlive the shell itself).
 */
function taskkillProcessTree(pid) {
  if (pid <= 0) return;
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}

/** Minimal node-pty terminal handle: output stream, exit outcome, teardown. */
var WindowsPtyHandle = class {
  terminal;
  graceMs;
  pid;
  output = new PassThrough();
  outcome = Promise.withResolvers();
  dataDisposable;
  exitDisposable;
  cleanup;
  exited = false;
  constructor(terminal, graceMs) {
    this.terminal = terminal;
    this.graceMs = graceMs;
    this.pid = terminal.pid;
    this.dataDisposable = terminal.onData((data) => {
      this.output.write(Buffer.from(data, "utf8"));
    });
    this.exitDisposable = terminal.onExit(({ exitCode, signal: exitSignal }) => {
      if (this.exited) return;
      this.exited = true;
      this.output.end();
      this.outcome.resolve({
        exitCode: exitSignal === void 0 || exitSignal === 0 ? exitCode : null,
        signal: signalName(exitSignal)
      });
    });
  }
  get done() { return this.outcome.promise; }
  async write(data) {
    if (this.exited) throw new Error("terminal process has exited");
    this.terminal.write(data);
  }
  terminate() {
    if (this.cleanup !== void 0) return this.cleanup;
    const cleanup = this.closeOnce();
    this.cleanup = cleanup;
    cleanup.catch(() => { this.cleanup = void 0; });
    return cleanup;
  }
  async closeOnce() {
    if (!this.exited) {
      try { this.terminal.kill(); } catch (_alreadyExited) {}
      await Promise.race([this.done, delay(this.graceMs)]);
    }
    if (!this.exited) {
      taskkillProcessTree(this.pid);
      await Promise.race([this.done, delay(this.graceMs)]);
    }
    if (!this.exited) throw new Error(`terminal cleanup failed; surviving pid: ${this.pid}`);
    if (typeof this.dataDisposable?.dispose === "function") this.dataDisposable.dispose();
    if (typeof this.exitDisposable?.dispose === "function") this.exitDisposable.dispose();
  }
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backend session wrapping one node-pty pwsh process. */
var PwshPtySession = class {
  terminal;
  config;
  motd = "";
  pid;
  decoder = new TextDecoder();
  sanitizer;
  scrollback;
  outputEnded = Promise.withResolvers();
  completion;
  statusValue = { kind: "running" };
  active;
  activeTimer;
  activeDeadlineTimer;
  activeAbort;
  interrupting;
  activeWrite;
  pollingReady;
  polling = false;
  promptSeen = false;
  tailBuffer = "";
  initializing = false;
  lastOutputAt = Date.now();
  closing = false;
  closePromise;
  transportFailure;
  constructor(terminal, config) {
    this.terminal = terminal;
    this.config = config;
    this.pid = terminal.pid;
    this.sanitizer = new TerminalSanitizer(config.maxReadBytes);
    this.scrollback = new BoundedTextBuffer(config.scrollbackMaxBytes, config.scrollbackLines);
    terminal.output.on("data", this.onTerminalData);
    terminal.output.once("end", this.onTerminalEnd);
    terminal.output.once("error", this.onTerminalError);
    this.completion = terminal.done.then((outcome) => this.onExit(outcome), (error) => { this.onTransportFailure(error); });
  }
  async initialize(signal) {
    this.initializing = true;
    try {
      const result = await this.startSend({ text: "", submit: false, ...signal !== void 0 ? { signal } : {} }).done;
      if (result.waitReason === "session_exit") throw new Error("PTY shell exited during startup");
      if (result.waitReason === "timeout") throw new Error("PTY shell did not reach readiness before startup timeout");
      this.motd = result.viewport;
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      this.initializing = false;
    }
  }
  startSend(request) {
    if (this.closing) throw new Error("PTY session is closing");
    if (this.statusValue.kind === "exited") throw new Error("PTY session has exited");
    if (this.active !== void 0) throw new TerminalError(`PTY session already has an active send${this.activeWrite !== void 0 ? " or draining provider write" : this.interrupting !== void 0 ? " or draining foreground interrupt" : ""}`, "SEND_ACTIVE");
    if (request.signal?.aborted === true) throw new Error("PTY send aborted before write");
    const operation = new LocalSendOperation(this.config.maxReadBytes, Date.now(), () => { this.interrupt(operation); });
    this.active = operation;
    this.resetReadinessEvidence();
    if (request.signal !== void 0) {
      const onAbort = () => { operation.cancel(); };
      request.signal.addEventListener("abort", onAbort, { once: true });
      this.activeAbort = () => request.signal?.removeEventListener("abort", onAbort);
    }
    this.activeDeadlineTimer = setTimeout(() => {
      if (this.active === operation) this.settleActive("timeout", this.activeWrite !== void 0 || this.interrupting === operation);
    }, this.config.timeoutMs);
    this.beginSend(operation, request);
    return operation;
  }
  async beginSend(operation, request) {
    try {
      if (this.active !== operation || this.closing || this.interrupting === operation) return;
      const input = `${request.text}${request.submit ? "\r" : ""}`;
      if (input.length > 0 && !operation.cancelRequested) {
        this.resetReadinessEvidence();
        const write = this.terminal.write(input);
        this.activeWrite = write.then(() => true, () => false);
        try { await write; } finally { this.activeWrite = void 0; }
      }
      if (operation.cancelRequested) return;
      if (this.active === operation && operation.settled) {
        this.clearActive();
        return;
      }
      if (this.active === operation && !this.closing) {
        this.pollingReady = operation;
        this.schedulePoll(operation);
      }
    } catch (error) {
      if (this.active === operation && !this.closing) if (operation.settled) this.clearActive();
      else this.failActive(error);
    }
  }
  resetReadinessEvidence() {
    this.lastOutputAt = Date.now();
    this.promptSeen = false;
    this.tailBuffer = "";
  }
  read(request) {
    const snapshot = this.scrollback.snapshot();
    const lines = snapshot.text.split("\n");
    const totalLines = snapshot.text.length === 0 ? 0 : lines.length;
    const offset = request.offset ?? 0;
    const count = request.count ?? 500;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("PTY read offset must be a non-negative safe integer");
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("PTY read count must be a positive safe integer");
    if (offset >= totalLines) return { text: "", totalLines, lineBegin: offset, lineEnd: offset, truncated: snapshot.truncated };
    const end = totalLines - offset;
    const start = Math.max(0, end - count);
    const bounded = utf8Tail(lines.slice(start, end).join("\n"), this.config.maxReadBytes);
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split("\n").length;
    return { text: bounded.text, totalLines, lineBegin: offset, lineEnd: offset + returnedLines, truncated: snapshot.truncated || bounded.truncated };
  }
  async signal() {
    // The official backend delivers POSIX process-group signals; Windows
    // ConPTY sessions have no process groups. Explicit failure over silence.
    throw new Error("terminal-pwsh: process-group signals are not supported on Windows");
  }
  status() { return this.statusValue; }
  close(reason) {
    this.closing = true;
    if (this.closePromise !== void 0) return this.closePromise;
    const closing = this.closeOnce(reason).catch((error) => {
      this.closePromise = void 0;
      this.failActive(error);
      throw error;
    });
    this.closePromise = closing;
    return closing;
  }
  onTerminalData = (chunk) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.onData(this.decoder.decode(bytes, { stream: true }));
  };
  onTerminalEnd = () => {
    this.onData(this.decoder.decode());
    this.appendOutput(this.sanitizer.flush());
    this.outputEnded.resolve();
  };
  onTerminalError = (error) => {
    this.onTransportFailure(error);
    this.outputEnded.resolve();
  };
  onData(data) {
    const sanitized = this.sanitizer.push(data);
    this.appendOutput(sanitized.text);
    this.trackPrompt(sanitized.text);
  }
  /**
   * Prompt evidence by sanitized text tail. PowerShell/PSReadLine strip OSC
   * 133;D from the prompt string, so a bare controlled prompt is matched
   * instead. A trailing CSI cursor move is already removed by the sanitizer;
   * CR/LF line endings are tolerated. The window keeps split-chunk prompts
   * (e.g. "ds" / "h> ") detectable across data callbacks.
   */
  trackPrompt(text) {
    if (text.length === 0) return;
    this.tailBuffer = (this.tailBuffer + text).slice(-(CONTROLLED_PROMPT.length + 4));
    const tail = this.tailBuffer.replace(/\r?\n$/, "");
    if (tail.endsWith(CONTROLLED_PROMPT)) {
      this.promptSeen = true;
      this.lastOutputAt = Date.now();
    }
  }
  async onExit(outcome) {
    await this.outputEnded.promise;
    if (this.transportFailure !== void 0) return;
    this.statusValue = { kind: "exited", exitCode: outcome.exitCode, signal: outcome.signal };
    this.settleActive("session_exit");
  }
  onTransportFailure(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.transportFailure ??= failure;
    this.statusValue = { kind: "exited", exitCode: null, signal: null };
    this.failActive(failure);
    this.terminal.terminate().catch(() => {});
  }
  appendOutput(text) {
    if (text.length === 0) return;
    this.lastOutputAt = Date.now();
    this.scrollback.append(text);
    this.active?.append(text);
  }
  schedulePoll(operation, delayMs = this.config.pollIntervalMs) {
    if (this.active !== operation || this.interrupting === operation || this.polling) return;
    if (this.activeTimer !== void 0) clearTimeout(this.activeTimer);
    this.activeTimer = setTimeout(() => {
      this.activeTimer = void 0;
      this.pollReadiness(operation);
    }, delayMs);
  }
  async pollReadiness(operation) {
    if (this.active !== operation || this.polling) return;
    this.polling = true;
    try {
      if (this.statusValue.kind === "exited") {
        this.settleActive("session_exit");
        return;
      }
      const idleFor = Date.now() - this.lastOutputAt;
      if (this.promptSeen && idleFor >= this.config.pollIntervalMs) {
        this.settleActive("stdin_read");
        return;
      }
      const startupHasOutput = !this.initializing || this.scrollback.snapshot().text.length > 0;
      const handoffGrace = this.promptSeen ? this.config.handoffGraceMs : 0;
      if (startupHasOutput && idleFor >= this.config.idleSilenceMs + handoffGrace) this.settleActive("inferred_idle");
    } catch (error) {
      if (this.active === operation && !this.closing && this.interrupting !== operation) this.failActive(error);
    } finally {
      this.polling = false;
      const active = this.active;
      if (active !== void 0 && this.pollingReady === active) this.schedulePoll(active);
    }
  }
  settleActive(waitReason, retainOwnership = false) {
    const operation = this.active;
    if (operation === void 0) return;
    const scrollbackTruncated = this.scrollback.snapshot().truncated;
    if (retainOwnership) {
      this.stopPolling();
      this.activeAbort?.();
      this.activeAbort = void 0;
    } else this.clearActive();
    operation.settle(waitReason, this.statusValue, scrollbackTruncated);
  }
  stopPolling() {
    this.stopReadinessPolling();
    if (this.activeDeadlineTimer !== void 0) clearTimeout(this.activeDeadlineTimer);
    this.activeDeadlineTimer = void 0;
  }
  stopReadinessPolling() {
    if (this.activeTimer !== void 0) clearTimeout(this.activeTimer);
    this.activeTimer = void 0;
    this.pollingReady = void 0;
  }
  clearActive() {
    const operation = this.active;
    this.stopPolling();
    this.activeAbort?.();
    this.activeAbort = void 0;
    if (this.interrupting === operation) this.interrupting = void 0;
    this.pollingReady = void 0;
    this.active = void 0;
  }
  failActive(error) {
    const operation = this.active;
    if (operation === void 0) return;
    this.clearActive();
    operation.fail(error);
  }
  interrupt(operation) {
    // Windows has no foreground process group to signal. Keep polling so a
    // command that finishes on its own still settles; the tool's cancellation
    // contract recovers via its deadline and shell reset.
    if (this.active !== operation) return;
    if (this.active === operation && operation.settled) this.clearActive();
  }
  async closeOnce(reason) {
    this.stopPolling();
    try {
      await this.terminal.terminate();
    } catch (error) {
      throw new Error(`PTY cleanup failed (${reason})`, { cause: error });
    }
    this.settleActive("session_exit");
    await this.completion;
    this.terminal.output.off("data", this.onTerminalData);
    this.terminal.output.off("end", this.onTerminalEnd);
    this.terminal.output.off("error", this.onTerminalError);
    if (this.transportFailure !== void 0) throw this.transportFailure;
  }
};

/** Resolve `pwsh` to an absolute executable path (node-pty needs one on Windows). */
function resolveShellPath(config) {
  if (config.shellPath.length > 0) return config.shellPath;
  const found = findOnPath("pwsh");
  if (found !== void 0) return found;
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== void 0) {
    const alias = join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe");
    if (existsSync(alias)) return alias;
  }
  throw new Error('terminal-pwsh: could not resolve "pwsh" on PATH; set config.shellPath to the absolute pwsh.exe path');
}

function findOnPath(name) {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((entry) => entry.length > 0) : [""];
  const dirs = (process.env.PATH ?? "").split(pathDelimiter).filter((entry) => entry.length > 0);
  for (const dir of dirs) for (const extension of extensions) {
    const candidate = join(dir, name + extension);
    try { if (statSync(candidate).isFile()) return candidate; } catch (_missing) {}
  }
  return void 0;
}

const sandboxModeFences = /* @__PURE__ */ new WeakMap();

/**
 * Keep sandbox-mode changes consistent with live persistent terminals without
 * blocking mid-session mode switches. The official backend rejects every mode
 * change while a terminal is open; that blocks both directions, so this fence
 * instead closes every owner terminal in the background on ANY effective mode
 * change (widening or narrowing), and the tool lazily respawns on the next
 * call under the new mode.
 *
 * Closing on widening is required, not just safe: a persistent pwsh process
 * is confined by the Windows ACL sandbox at spawn time, and ACLs of a running
 * process cannot be widened. Keeping the old shell after read-only ->
 * danger-full-access would leave every subsequent command running under the
 * stale narrow ACL while the UI already reports the wider mode. Rebuilding
 * the shell guarantees its permissions always match the current session mode.
 */
function ensureSandboxModeFence(ctx, owner) {
  const existing = sandboxModeFences.get(owner);
  if (existing !== void 0) {
    existing.pty = ctx.terminals;
    existing.sandboxPolicy = ctx.sandboxPolicy;
    return;
  }
  const state = { pty: ctx.terminals, sandboxPolicy: ctx.sandboxPolicy };
  sandboxModeFences.set(owner, state);
  owner.ctx.on("internal/dispatch", (_mode, eventName, args) => {
    if (eventName !== "session/event") return;
    const [session, event] = args;
    if (session !== owner.session || event.type !== "sandbox/mode") return;
    const currentMode = effectiveSandboxMode(session.events) ?? state.sandboxPolicy.defaultMode;
    if (event.data.mode === currentMode || !state.pty.hasOwnerActivity(owner)) return;
    // Any real mode change: close the owner's sessions in the background so
    // no terminal outlives the mode it was spawned under. The next tool call
    // lazily spawns a fresh shell under the new mode.
    void state.pty.abortAndClose(
      owner,
      new Error(`sandbox mode changed from "${currentMode}" to "${event.data.mode}"; persistent terminal sessions were closed and will respawn under the new mode`),
      `sandbox mode changed from "${currentMode}" to "${event.data.mode}"`
    ).catch(() => {});
  }, { global: true });
}

function childEnvironment(spec) {
  return {
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    DSH_SHELL: "1",
    DSH_SESSION_ID: spec.owner.id,
    DSH_PTY_SESSION_ID: spec.sessionId
  };
}

/** Windows-aware env merge over the scrubbed parent environment. */
function childEnv(extra) {
  const env = scrubbedParentEnv();
  if (process.platform !== "win32") return { ...env, ...extra };
  let entries = Object.entries(env);
  for (const [key, value] of Object.entries(extra ?? {})) {
    const normalized = key.toUpperCase();
    entries = entries.filter(([inherited]) => inherited.toUpperCase() !== normalized);
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

function spawnArgv(ctx, config, policy) {
  const argv = [resolveShellPath(config), ...config.shellArgs];
  if (policy.mode === "danger-full-access") return argv;
  const sandbox = ctx.get("sandbox");
  if (sandbox === void 0) throw new Error(`terminal-pwsh: sandbox mode "${policy.mode}" requires a ctx.sandbox provider in the execution world`);
  return sandbox.confine(argv, { ...policy, mode: policy.mode }).argv;
}

/** Spawn pwsh through node-pty directly (the subprocess seam's terminal is Linux/macOS-only). */
async function spawnPwshTerminal(spec) {
  spec.signal?.throwIfAborted();
  const options = {
    name: "dumb",
    rows: spec.rows,
    cols: spec.cols,
    cwd: spec.cwd,
    env: childEnv(spec.env)
  };
  let terminal;
  try {
    terminal = nodePty.spawn(spec.argv[0], [...spec.argv.slice(1)], options);
  } catch (error) {
    // ConPTY needs a named pipe (\\.\pipe\conpty-*); the Windows sandbox
    // denies pipe opens in confined modes, so the persistent shell can only
    // run under danger-full-access. Surface that as an actionable error.
    if (error?.code === "EPERM" || /pipe/i.test(String(error?.message ?? ""))) {
      throw new Error("terminal-pwsh: cannot open the ConPTY pipe — the persistent pwsh shell requires danger-full-access sandbox mode (the Windows sandbox denies named pipes in confined modes); switch the session mode and retry", { cause: error });
    }
    throw error;
  }
  return new WindowsPtyHandle(terminal, spec.graceMs);
}

async function initializeSession(session, signal) {
  if (signal === void 0) {
    await session.initialize(signal);
    return;
  }
  const aborted = Promise.withResolvers();
  const onAbort = () => { aborted.reject(signal.reason); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    await Promise.race([session.initialize(signal), aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Local pwsh backend registered under the configured type. */
var PwshTerminalBackend = class {
  ctx;
  config;
  spawnTerminal;
  createSession;
  type;
  constructor(ctx, config, spawnTerminal = (spec) => spawnPwshTerminal(spec), createSession = (terminal, config) => new PwshPtySession(terminal, config)) {
    this.ctx = ctx;
    this.config = config;
    this.spawnTerminal = spawnTerminal;
    this.createSession = createSession;
    this.type = config.backendType;
  }
  async spawn(spec) {
    spec.signal?.throwIfAborted();
    ensureSandboxModeFence(this.ctx, spec.owner);
    const policy = this.ctx.sandboxPolicy.resolve({ session: spec.owner.session });
    const argv = spawnArgv(this.ctx, this.config, policy);
    if (argv[0] === void 0) throw new Error("terminal-pwsh: sandbox returned empty argv");
    const terminal = await this.spawnTerminal({
      argv,
      cwd: spec.cwd ?? policy.workspaceRoot,
      env: childEnvironment(spec),
      rows: this.config.rows,
      cols: this.config.cols,
      graceMs: this.config.disposeGraceMs,
      signal: spec.signal
    });
    const session = this.createSession(terminal, this.config);
    try {
      await initializeSession(session, spec.signal);
      return session;
    } catch (error) {
      try {
        await session.close("PTY startup failed");
      } catch (closeError) {
        throw new TerminalBackendCleanupError(error, closeError);
      }
      throw error;
    }
  }
};

/** Cordis plugin name. */
const name = "terminal-pwsh";
/** Required services: PTY registry and shared confinement policy. */
const inject = ["terminals", "sandboxPolicy"];

/** Register the local pwsh PTY backend. */
function apply(ctx, config) {
  validateConfig(config);
  ctx.terminals.registerBackend(new PwshTerminalBackend(ctx, config));
}

export { Config, PwshTerminalBackend, apply, inject, name };
