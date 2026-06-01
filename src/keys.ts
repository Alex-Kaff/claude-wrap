// Shared ANSI key sequences for the control channel.
//
// Used by both the in-process API (`ClaudeInstance.sendKey`) and the
// `claude-wrap-inject` CLI (`inject key <name>`) so the two never drift.

export const KEYS: Record<string, string> = {
  enter: "\r",
  return: "\r",
  tab: "\t",
  // Back-tab (Shift+Tab). Claude Code uses this to cycle permission modes
  // (normal → auto → accept edits → plan). Several spellings map to it so
  // callers don't have to guess.
  "shift-tab": "\x1b[Z",
  "shift+tab": "\x1b[Z",
  btab: "\x1b[Z",
  esc: "\x1b",
  escape: "\x1b",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  delete: "\x1b[3~",
  backspace: "\x7f",
  "ctrl-a": "\x01",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  "ctrl-e": "\x05",
  "ctrl-l": "\x0c",
  "ctrl-u": "\x15",
};
