// ClaudeManager: top-level orchestrator that owns multiple sessions (PTY-backed
// ClaudeInstance and print-backed PrintSession) and provides aggregated event
// subscription.
//
// Lifecycle is unified through the ManagedSession interface (§2.4 / §12-D7): one
// Map<string, ManagedSession> backs get/list/destroyAll/shutdownAll. Typed
// events stay per-kind — the PTY `emitter` (SessionEvents) is untouched; print
// sessions feed a separate `printEmitter` (PrintEvents) via an ALL_PRINT_EVENTS
// forward loop — because the two event shapes are genuinely different.

import { ClaudeInstance, type SpawnOptions } from "./instance";
import { PrintSession, type PrintSessionOptions } from "./print/print-session";
import { createEmitter, ALL_SESSION_EVENTS, type TypedEmitter, type SessionEvents } from "./events";
import { ALL_PRINT_EVENTS, type PrintEvents } from "./print/print-events";
import type { ManagedSession } from "./managed";

export class ClaudeManager {
  private sessions = new Map<string, ManagedSession>();
  /** Forwarding unsubscribe functions per session id (events + exit hook). */
  private forwarders = new Map<string, (() => void)[]>();

  /** Aggregated PTY events from all ClaudeInstance sessions. */
  readonly emitter: TypedEmitter<SessionEvents> = createEmitter<SessionEvents>();
  /** Aggregated print events from all PrintSession sessions. */
  readonly printEmitter: TypedEmitter<PrintEvents> = createEmitter<PrintEvents>();

  /**
   * Spawn a new PTY-backed Claude Code instance. Returns the instance handle.
   * Throws if the PTY fails to spawn (e.g. `claude` not on PATH).
   */
  spawn(opts?: SpawnOptions): ClaudeInstance {
    const instance = new ClaudeInstance(opts);
    this.sessions.set(instance.id, instance);

    const unsubs: (() => void)[] = [];
    for (const event of ALL_SESSION_EVENTS) {
      unsubs.push(
        instance.on(event, (payload: SessionEvents[typeof event]) => {
          this.emitter.emit(event, payload);
        }),
      );
    }
    unsubs.push(instance.onExit(() => this.detach(instance.id)));
    this.forwarders.set(instance.id, unsubs);
    return instance;
  }

  /**
   * Create a new print-backed (`claude -p` structured-protocol) session.
   * Returns the PrintSession handle; auto-detaches on process exit.
   */
  print(opts?: PrintSessionOptions): PrintSession {
    const session = new PrintSession(opts);
    this.sessions.set(session.id, session);

    const unsubs: (() => void)[] = [];
    for (const event of ALL_PRINT_EVENTS) {
      unsubs.push(
        session.on(event, (payload: PrintEvents[typeof event]) => {
          this.printEmitter.emit(event, payload);
        }),
      );
    }
    unsubs.push(session.onExit(() => this.detach(session.id)));
    this.forwarders.set(session.id, unsubs);
    return session;
  }

  /** Unsubscribe forwarding listeners and remove the session from tracking. */
  private detach(id: string): void {
    const unsubs = this.forwarders.get(id);
    if (unsubs) {
      for (const u of unsubs) u();
      this.forwarders.delete(id);
    }
    this.sessions.delete(id);
  }

  /** Get a session by id or label. First-match semantics for labels. */
  get(idOrLabel: string): ManagedSession | undefined {
    const direct = this.sessions.get(idOrLabel);
    if (direct) return direct;
    for (const s of this.sessions.values()) {
      if (s.label === idOrLabel) return s;
    }
    return undefined;
  }

  /** All live sessions (both kinds). */
  list(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  /** Number of live sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Subscribe to PTY events from ALL ClaudeInstance sessions. */
  on<K extends keyof SessionEvents>(
    event: K,
    handler: (payload: SessionEvents[K]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  /** Subscribe to print events from ALL PrintSession sessions. */
  onPrint<K extends keyof PrintEvents>(
    event: K,
    handler: (payload: PrintEvents[K]) => void,
  ): () => void {
    return this.printEmitter.on(event, handler);
  }

  /** Tear down everything. Fire-and-forget kill signals. */
  destroyAll(): void {
    const all = [...this.sessions.values()];
    for (const s of all) s.destroy();
    // Immediately detach forwarding so no stale exit events leak afterward.
    for (const id of [...this.sessions.keys()]) this.detach(id);
  }

  /** Graceful shutdown: wait for all sessions to actually exit. */
  async shutdownAll(opts?: { timeoutMs?: number }): Promise<void> {
    const all = [...this.sessions.values()];
    for (const id of [...this.sessions.keys()]) this.detach(id);
    await Promise.all(all.map((s) => s.shutdown(opts)));
  }
}
