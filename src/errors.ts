// Typed error hierarchy for claude-wrap.
//
// Expected, pattern-matchable failures subclass `Error` with a stable
// class name. Automation scripts can write:
//
//   try { await inject.ask(...); }
//   catch (e) {
//     if (e instanceof TimeoutError) ...
//     else if (e instanceof PipeError) ...
//   }
//
// Unexpected programmer errors (invariant violations, bad JSON we
// generated ourselves) still throw plain Error and bubble to main().

export class PipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipeError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/**
 * Protocol version mismatch. Deliberately NOT a subclass of PipeError
 * so that `catch (e) { if (e instanceof PipeError) retry; }` retry
 * loops don't spin forever against an incompatible server. Callers
 * that want to treat both as "wire-layer errors" should check both
 * explicitly.
 */
export class ProtocolVersionError extends Error {
  constructor(
    message: string,
    public readonly remoteVersion: number | null,
  ) {
    super(message);
    this.name = "ProtocolVersionError";
  }
}

// ---------------------------------------------------------------------------
// Print-transport errors (`claude -p` structured-protocol client)
// ---------------------------------------------------------------------------

/**
 * The print stdout stream ended (or the one-shot JSON array completed) without
 * a `result` message for the in-flight turn. Carries any captured stderr to aid
 * diagnosis.
 */
export class MalformedStreamError extends Error {
  constructor(
    message: string,
    public readonly stderr: string = "",
  ) {
    super(message);
    this.name = "MalformedStreamError";
  }
}

/**
 * The `claude` print process exited (non-zero, or before producing a `result`).
 * Carries the exit code and captured stderr.
 */
export class ProcessExitError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly stderr: string = "",
  ) {
    super(message);
    this.name = "ProcessExitError";
  }
}

/** A print turn did not produce its `result` within the configured timeout. */
export class TurnTimeoutError extends TimeoutError {
  constructor(message: string) {
    super(message);
    this.name = "TurnTimeoutError";
  }
}

/** A requested capability isn't available yet (e.g. interrupt before the M4 control handshake). */
export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSupportedError";
  }
}
