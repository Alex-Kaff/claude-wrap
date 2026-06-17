// ManagedSession: the minimal lifecycle interface that ClaudeManager tracks
// uniformly across transports (§2.4 / §12-D7).
//
// Both the PTY-backed ClaudeInstance and the print-backed PrintSession
// implement this, so the manager can keep one Map<string, ManagedSession> and
// expose unified get/list/destroyAll/shutdownAll. Typed event surfaces stay
// per-kind (SessionEvents vs PrintEvents); exit is the one event normalized
// here, because the manager needs it for auto-detach.

export interface ManagedSession {
  readonly id: string;
  readonly label: string;
  readonly cwd: string;
  readonly kind: "pty" | "print";
  readonly alive: boolean;

  /**
   * Subscribe to process exit, normalized across transports. The handler
   * receives the exit code (or null). Returns an unsubscribe function. This is
   * the lifecycle hook the manager uses; richer, kind-specific events stay on
   * each concrete class's typed `.on()`.
   */
  onExit(handler: (code: number | null) => void): () => void;

  /** Synchronous teardown (fire-and-forget kill). Idempotent. */
  destroy(): void;

  /** Graceful shutdown: tear down and await actual process exit. */
  shutdown(opts?: { timeoutMs?: number }): Promise<void>;
}
