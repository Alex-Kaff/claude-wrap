// Shared ANSI key sequences for the control channel.
//
// Used by both the in-process API (`ClaudeInstance.sendKey`) and the
// `claude-wrap-inject` CLI (`inject key <name>`) so the two never drift.

export const KEYS: Record<string, string> = {
  enter: "\r",
  tab: "\t",
  esc: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  backspace: "\x7f",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  "ctrl-l": "\x0c",
};
