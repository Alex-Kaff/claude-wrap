// ClaudeManager: top-level orchestrator that owns multiple ClaudeInstance
// objects and provides aggregated event subscription.

import { ClaudeInstance, type SpawnOptions } from "./instance";
import { createEmitter, ALL_SESSION_EVENTS, type TypedEmitter, type SessionEvents } from "./events";

export class ClaudeManager {
  private instances = new Map<string, ClaudeInstance>();
  /** Forwarding unsubscribe functions per instance id. */
  private forwarders = new Map<string, (() => void)[]>();
  readonly emitter: TypedEmitter<SessionEvents> = createEmitter<SessionEvents>();

  /**
   * Spawn a new Claude Code instance. Returns the instance handle.
   * Throws if the PTY fails to spawn (e.g. `claude` not on PATH).
   */
  spawn(opts?: SpawnOptions): ClaudeInstance {
    const instance = new ClaudeInstance(opts);
    this.instances.set(instance.id, instance);

    // Forward all events from the instance to the manager's emitter
    const unsubs: (() => void)[] = [];
    for (const event of ALL_SESSION_EVENTS) {
      unsubs.push(
        instance.on(event, (payload: any) => {
          this.emitter.emit(event, payload);
        }),
      );
    }
    this.forwarders.set(instance.id, unsubs);

    // Auto-remove on exit
    instance.on("process:exit", () => {
      this.detach(instance.id);
    });

    return instance;
  }

  /** Unsubscribe forwarding listeners and remove instance from tracking. */
  private detach(id: string): void {
    const unsubs = this.forwarders.get(id);
    if (unsubs) {
      for (const u of unsubs) u();
      this.forwarders.delete(id);
    }
    this.instances.delete(id);
  }

  /** Get an instance by id or label. First-match semantics for labels. */
  get(idOrLabel: string): ClaudeInstance | undefined {
    const direct = this.instances.get(idOrLabel);
    if (direct) return direct;
    for (const inst of this.instances.values()) {
      if (inst.label === idOrLabel) return inst;
    }
    return undefined;
  }

  /** All live instances. */
  list(): ClaudeInstance[] {
    return [...this.instances.values()];
  }

  /** Number of live instances. */
  get size(): number {
    return this.instances.size;
  }

  /** Subscribe to events from ALL instances. */
  on<K extends keyof SessionEvents>(
    event: K,
    handler: (payload: SessionEvents[K]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  /** Tear down everything. Fire-and-forget kill signals. */
  destroyAll(): void {
    for (const inst of this.instances.values()) {
      inst.destroy();
    }
    // Immediately detach forwarding so no stale process:exit events
    // leak to the manager emitter after destroyAll returns.
    for (const id of [...this.instances.keys()]) {
      this.detach(id);
    }
  }

  /** Graceful shutdown: wait for all processes to actually exit. */
  async shutdownAll(opts?: { timeoutMs?: number }): Promise<void> {
    const insts = [...this.instances.values()];
    // Detach forwarding first so post-exit events don't leak
    for (const id of [...this.instances.keys()]) {
      this.detach(id);
    }
    await Promise.all(insts.map((inst) => inst.shutdown(opts)));
  }
}
