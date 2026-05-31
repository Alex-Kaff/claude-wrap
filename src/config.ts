// Central configuration constants for claude-wrap.
//
// These are tuning knobs that different modules want to share or that
// tests want to override. Keeping them in one file (rather than as
// local magic numbers) makes it easy to find what's tunable and to
// override specific values via env for benchmarking / testing.
//
// Philosophy: values here are typed constants, not runtime-mutable
// state. Env overrides are read once at module load. Callers never
// mutate these.

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  // Accept zero — tests or power users may want to disable a delay or
  // a scrollback budget entirely. Reject NaN and negatives only.
  if (!Number.isFinite(n) || n < 0) {
    // eslint-disable-next-line no-console
    console.warn(`[config] ignoring invalid ${name}=${raw}, using fallback ${fallback}`);
    return fallback;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Polling / waits
// ---------------------------------------------------------------------------

/** Milliseconds between consecutive snapshot polls in wait loops. */
export const POLL_INTERVAL_MS = envNum("CLAUDE_WRAP_POLL_MS", 400);

/** Default budget for wait-idle before it rejects. */
export const WAIT_IDLE_TIMEOUT_MS = envNum("CLAUDE_WRAP_WAIT_IDLE_MS", 120_000);

/** Default budget for wait-for before it rejects. */
export const WAIT_FOR_TIMEOUT_MS = envNum("CLAUDE_WRAP_WAIT_FOR_MS", 60_000);

/** Delay after `inject ask` sends text before the first idle poll fires. */
export const ASK_SETTLE_MS = envNum("CLAUDE_WRAP_ASK_SETTLE_MS", 300);

/** Debounce interval for the ContinuousParser reparse cycle. */
export const PARSE_DEBOUNCE_MS = envNum("CLAUDE_WRAP_PARSE_DEBOUNCE_MS", 50);

/** Max time ask() waits for Claude to become busy before proceeding. */
export const ASK_SETTLE_TIMEOUT_MS = envNum("CLAUDE_WRAP_ASK_SETTLE_TIMEOUT_MS", 5_000);

// ---------------------------------------------------------------------------
// Virtual screen
// ---------------------------------------------------------------------------

/** xterm headless scrollback line budget. */
export const SCROLLBACK_LINES = envNum("CLAUDE_WRAP_SCROLLBACK", 5000);

// ---------------------------------------------------------------------------
// Parser tuning
// ---------------------------------------------------------------------------

/** Busy-glyph scan window: last N non-empty lines of the snapshot tail. */
export const BUSY_WINDOW_LINES = 16;

/**
 * cutRightUI default: minimum run of spaces that counts as a
 * "right-column UI gap". Smaller = more aggressive stripping.
 */
export const RIGHT_UI_MIN_GAP = 5;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Max bytes before wrap.log rotates. */
export const LOG_ROTATE_BYTES = envNum("CLAUDE_WRAP_LOG_BYTES", 1_000_000);

/** Number of rotated log files kept (wrap.log.1 .. wrap.log.N). */
export const LOG_ROTATE_KEEP = 3;

// ---------------------------------------------------------------------------
// HTTP bridge
// ---------------------------------------------------------------------------

/** Hard cap on a POST body accepted by the HTTP bridge. */
export const HTTP_MAX_BODY_BYTES = 10_000_000;
