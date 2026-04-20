// tmux-backed injector for mirror-session remote input.
//
// Uses `tmux send-keys -l` (literal mode) to deliver the prompt text
// verbatim to the target pane, then a separate `tmux send-keys Enter`
// to submit. Literal mode is important: without it, control sequences,
// backticks, $(cmd) and friends in the prompt would be interpreted by
// tmux's key-name parser. With `-l`, every byte is a keystroke.
//
// Rate-limits to 1 inject per session per RATE_LIMIT_MS.
// Caps prompt length at MAX_PROMPT_BYTES.
// Rejects empty / whitespace-only prompts.
//
// The tmux binary is looked up via $TMUX_BIN (for tests) → $PATH.

import { spawn } from "node:child_process";

export const MAX_PROMPT_BYTES = 32 * 1024;
export const RATE_LIMIT_MS = 250;
const SEND_KEYS_TIMEOUT_MS = 2_000;

export type InjectResult =
  | { ok: true }
  | {
      ok: false;
      code: "empty" | "too_long" | "rate_limited" | "tmux_failed";
      error: string;
    };

export interface TmuxInjectorOptions {
  /** Override tmux binary path. Default: $TMUX_BIN or "tmux". */
  tmuxBin?: string;
  /** Override rate-limit interval. */
  rateLimitMs?: number;
}

export class TmuxInjector {
  private tmuxBin: string;
  private rateLimitMs: number;
  private lastInjectAt = new Map<string, number>();

  constructor(opts: TmuxInjectorOptions = {}) {
    this.tmuxBin = opts.tmuxBin ?? process.env.TMUX_BIN ?? "tmux";
    this.rateLimitMs = opts.rateLimitMs ?? RATE_LIMIT_MS;
  }

  async inject(sid: string, pane: string, text: string): Promise<InjectResult> {
    const trimmed = text.replace(/\s+$/, "");
    if (trimmed.length === 0) {
      return {
        ok: false,
        code: "empty",
        error: "Empty or whitespace-only prompt.",
      };
    }
    if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
      return {
        ok: false,
        code: "too_long",
        error: `Prompt exceeds ${MAX_PROMPT_BYTES} bytes.`,
      };
    }
    const now = Date.now();
    const last = this.lastInjectAt.get(sid) ?? 0;
    if (now - last < this.rateLimitMs) {
      return {
        ok: false,
        code: "rate_limited",
        error: `Rate limit: one inject per ${this.rateLimitMs}ms per session.`,
      };
    }
    this.lastInjectAt.set(sid, now);

    // Step 1: deliver the literal bytes to the pane.
    const litResult = await runTmux(this.tmuxBin, [
      "send-keys",
      "-t",
      pane,
      "-l",
      "--",
      text,
    ]);
    if (!litResult.ok) {
      return { ok: false, code: "tmux_failed", error: litResult.error };
    }

    // Step 2: press Enter to submit.
    const enterResult = await runTmux(this.tmuxBin, [
      "send-keys",
      "-t",
      pane,
      "Enter",
    ]);
    if (!enterResult.ok) {
      return { ok: false, code: "tmux_failed", error: enterResult.error };
    }

    return { ok: true };
  }

  /** Test helper: clear the rate-limit state. */
  resetRateLimit(sid?: string): void {
    if (sid) this.lastInjectAt.delete(sid);
    else this.lastInjectAt.clear();
  }
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string;
}

function runTmux(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: RunResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    let stdout = "";
    let stderr = "";
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      settle({
        ok: false,
        stdout: "",
        stderr: "",
        error: `failed to spawn ${bin}: ${String(err)}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      settle({
        ok: false,
        stdout,
        stderr,
        error: `${bin} send-keys timed out after ${SEND_KEYS_TIMEOUT_MS}ms`,
      });
    }, SEND_KEYS_TIMEOUT_MS);
    if (typeof timer === "object" && "unref" in timer) timer.unref();

    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      settle({ ok: false, stdout, stderr, error: err.message });
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        settle({ ok: true, stdout, stderr, error: "" });
      } else {
        settle({
          ok: false,
          stdout,
          stderr,
          error: `${bin} exited with code ${code}: ${stderr.trim()}`,
        });
      }
    });
  });
}
