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
