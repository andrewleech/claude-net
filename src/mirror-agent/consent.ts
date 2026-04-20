// First-inject consent flow for mirror-session.
//
// Four modes:
//   - "ask-first-per-session" (default) — prompt once on the first remote
//     inject for each session; allow all subsequent injects silently.
//   - "ask-every-time"                   — prompt on every inject.
//   - "always"                           — allow without prompting.
//   - "never"                            — reject without prompting.
//
// Prompting, when required, uses `tmux display-popup` anchored to the
// session's tmux pane. The user presses Enter within `timeoutMs` to
// accept or Ctrl-C to reject. If tmux is unavailable or the session has
// no tmux pane recorded, consent falls back to "never" (inject disabled
// for read-only sessions).

import { spawn } from "node:child_process";

export type ConsentMode =
  | "ask-first-per-session"
  | "ask-every-time"
  | "always"
  | "never";

export type ConsentResult =
  | { ok: true }
  | {
      ok: false;
      reason: "rejected" | "timeout" | "unavailable";
      message: string;
    };

export interface ConsentOptions {
  /** Default for all sessions. Overrideable per-session. */
  defaultMode?: ConsentMode;
  /** Time the user has to accept, in ms. */
  timeoutMs?: number;
  /** Override tmux binary. Default: $TMUX_BIN or "tmux". */
  tmuxBin?: string;
}

interface SessionConsent {
  mode: ConsentMode;
  accepted: boolean;
}

export class ConsentManager {
  private defaultMode: ConsentMode;
  private timeoutMs: number;
  private tmuxBin: string;
  private state = new Map<string, SessionConsent>();

  constructor(opts: ConsentOptions = {}) {
    this.defaultMode = opts.defaultMode ?? "ask-first-per-session";
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.tmuxBin = opts.tmuxBin ?? process.env.TMUX_BIN ?? "tmux";
  }

  /** Explicitly set a mode for a session (e.g. from the plugin mirror_consent tool). */
  setMode(sid: string, mode: ConsentMode): void {
    const cur = this.state.get(sid) ?? {
      mode: this.defaultMode,
      accepted: false,
    };
    cur.mode = mode;
    if (mode === "always") cur.accepted = true;
    if (mode === "never") cur.accepted = false;
    this.state.set(sid, cur);
  }

  /** Reset consent state for a session (prompt on next inject). */
  reset(sid: string): void {
    const cur = this.state.get(sid);
    if (cur) cur.accepted = false;
  }

  /** Remove any record for a session. */
  forget(sid: string): void {
    this.state.delete(sid);
  }

  /**
   * Decide whether to allow an inject for a session, prompting if needed.
   * `pane` is the tmux pane id captured from hook env; may be empty if the
   * session is not running inside tmux.
   */
  async check(
    sid: string,
    pane: string | null | undefined,
    watcher: string,
  ): Promise<ConsentResult> {
    const cur = this.state.get(sid) ?? {
      mode: this.defaultMode,
      accepted: false,
    };
    this.state.set(sid, cur);

    if (cur.mode === "always") return { ok: true };
    if (cur.mode === "never") {
      return {
        ok: false,
        reason: "rejected",
        message: "Consent mode is 'never' for this session.",
      };
    }
    if (cur.mode === "ask-first-per-session" && cur.accepted) {
      return { ok: true };
    }

    // We need to prompt. Only possible when we have a tmux pane.
    if (!pane) {
      return {
        ok: false,
        reason: "unavailable",
        message:
          "Consent required but no tmux pane is recorded for this session. Set consent mode to 'always' if you're in a controlled environment.",
      };
    }

    const popup = await this.promptViaPopup(pane, watcher);
    if (popup.ok) {
      cur.accepted = true;
      return { ok: true };
    }
    return popup;
  }

  private promptViaPopup(
    pane: string,
    watcher: string,
  ): Promise<ConsentResult> {
    const timeoutSeconds = Math.max(1, Math.ceil(this.timeoutMs / 1000));
    const safeWatcher = watcher.replace(/["'`$\\]/g, "?");
    // The popup runs a short shell script. `read -t N -p "..."` prompts for
    // input; Enter → exit 0 → accept, Ctrl-C / timeout → non-zero → reject.
    const shellCmd = `read -t ${timeoutSeconds} -p "[claude-net/mirror] inject requested by '${safeWatcher}' — press Enter to accept, Ctrl-C to reject (${timeoutSeconds}s): " && exit 0 || exit 2`;

    return new Promise((resolve) => {
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(
          this.tmuxBin,
          [
            "display-popup",
            "-E",
            "-t",
            pane,
            "-w",
            "80",
            "-h",
            "3",
            "bash",
            "-c",
            shellCmd,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (err) {
        resolve({
          ok: false,
          reason: "unavailable",
          message: `Failed to spawn tmux display-popup: ${String(err)}`,
        });
        return;
      }

      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, this.timeoutMs + 2000);
      if (typeof timer === "object" && "unref" in timer) timer.unref();

      proc.on("error", (err: Error) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          reason: "unavailable",
          message: `tmux display-popup error: ${err.message}`,
        });
      });
      proc.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ ok: true });
        } else if (code === 2 || code === 1) {
          resolve({
            ok: false,
            reason: "rejected",
            message: "User rejected or timed out.",
          });
        } else {
          resolve({
            ok: false,
            reason: "timeout",
            message: `display-popup exited with code ${code}`,
          });
        }
      });
    });
  }

  /** Inspect current state (tests / /status endpoints). */
  describe(sid: string): { mode: ConsentMode; accepted: boolean } {
    const cur = this.state.get(sid);
    return cur
      ? { mode: cur.mode, accepted: cur.accepted }
      : { mode: this.defaultMode, accepted: false };
  }
}
