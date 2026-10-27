import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AgentId,
  ProviderKind,
  ThreadId,
  type Device,
  type MachineCallOrigin,
  type MachineCapability,
  type WorkspaceId,
} from "@ace/protocol";
import { agentOwner } from "@ace/devices";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import { clip } from "../agent-control/watch-view.ts";
import { TargetRefusal } from "./target-refusal.ts";
import type { TargetThreads } from "./target-threads.ts";
import type { Risk } from "./grant-rules.ts";

export interface GuestSessionDeps {
  store: Store;
  engine(): Engine | undefined;
  threads: TargetThreads;
  /** A fresh hidden chat project for a new session's thread (ADR 0099). */
  chat(): Promise<{ id: WorkspaceId; path: string }>;
  /** Ids for background rows; random in the daemon, counted in tests. */
  newId(): string;
}

/** Where one calling thread's remote tool use runs on this machine (ADR 0105). */
export interface GuestSession {
  threadId: ThreadId;
  /** The session thread's root agent: the scope browser tools act as. */
  agentId: AgentId;
  deviceId: string;
  /**
   * The calling agent's owner for leases here (devices, screen), in `agentOwner`'s shape. Stable
   * per calling device, host, thread and agent, so no two remote agents share a lease.
   */
  owner: string;
}

/** What `run` is told about one call. */
export interface GuestWork {
  capability: MachineCapability;
  risk: Risk;
  /** The background row's words, e.g. "browser_open from Linux box". */
  label: string;
}

/** Why work in a session ended early, for the stage-2 lease and screen releases. */
export interface GuestEnd {
  session: GuestSession;
  capability: MachineCapability;
  reason: "stopped" | "revoked";
}

type Flight = GuestWork & {
  session: GuestSession;
  controller: AbortController;
  why?: "stopped" | "revoked";
};
const prefix = "ace-guest:";
const Row = z.object({ thread_id: z.string() });

/**
 * Guest sessions: one engine thread per (calling device, host, thread), in its own hidden chat
 * project, with no provider. Each call in flight holds a stoppable background row there, so the
 * person sees the work, can stop it, and the thread never reads done while it runs.
 */
export class GuestSessions {
  private deps: GuestSessionDeps;
  private opening = new Map<string, Promise<ThreadId>>();
  private flights = new Map<string, Flight>();
  private ends = new Set<(end: GuestEnd) => void>();
  constructor(deps: GuestSessionDeps) {
    this.deps = deps;
  }
  /** Whether a thread here is a guest session. */
  isGuest(threadId: string): boolean {
    return this.deps.threads.owner(threadId)?.kind === "guest";
  }
  /** The calling thread's session, made on first use. Concurrent first calls share one. */
  async open(device: Device, origin: MachineCallOrigin): Promise<GuestSession> {
    const engine = this.deps.engine();
    if (!engine) throw new TargetRefusal("unavailable", "Agents are starting on this machine.");
    const key = JSON.stringify([device.id, origin.hostId, origin.threadId]);
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.find(device, origin) ?? this.create(device, origin, engine);
      this.opening.set(key, pending);
      void pending.finally(() => this.opening.delete(key)).catch(() => undefined);
    }
    const threadId = await pending;
    const agentId = engine.rootAgent(threadId);
    if (!agentId) throw new TargetRefusal("unavailable", "The session is not ready.");
    return {
      threadId,
      agentId: AgentId.parse(agentId),
      deviceId: device.id,
      owner: agentOwner(threadId, `remote:${origin.agentId ?? "agent"}`),
    };
  }
  /** The newest session this calling thread has here that the person hasn't deleted. */
  private find(device: Device, origin: MachineCallOrigin): Promise<ThreadId> | undefined {
    const row = this.deps.store
      .statement(
        `SELECT thread_id FROM machine_threads WHERE device_id=? AND origin_host=?
         AND origin_thread=? AND kind='guest' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(device.id, origin.hostId, origin.threadId);
    if (!row) return undefined;
    const threadId = ThreadId.parse(Row.parse(row).thread_id);
    const thread = this.deps.store.getThread(threadId);
    return thread && thread.deletedAt === undefined ? Promise.resolve(threadId) : undefined;
  }
  private async create(device: Device, origin: MachineCallOrigin, engine: Engine) {
    // A deleted session is never reused: the next one gets the next generation's id.
    const generation = Number(
      this.deps.store
        .statement(
          "SELECT COUNT(*) AS n FROM machine_threads WHERE device_id=? AND origin_host=? AND origin_thread=? AND kind='guest'",
        )
        .get(device.id, origin.hostId, origin.threadId)?.["n"] ?? 0,
    );
    const hash = createHash("sha256")
      .update(JSON.stringify([device.id, origin.hostId, origin.threadId, generation]))
      .digest("hex")
      .slice(0, 32);
    const threadId = ThreadId.parse(`machine-guest-${hash}`);
    const project = await this.deps.chat();
    // Recorded only: nothing launches it, so a machine with no provider installed hosts it.
    const provider =
      ProviderKind.options.find((kind) => engine.providerAvailability(kind).installed) ?? "claude";
    engine.guests.create({
      id: threadId,
      workspaceId: project.id,
      title: clip(`${origin.hostName} · ${origin.threadTitle || "Agent"}`, 256),
      provider,
      cwd: project.path,
      guest: { host: origin.hostId, name: origin.hostName },
    });
    this.deps.threads.record(device, threadId, "guest", origin);
    return threadId;
  }
  /**
   * Runs one call in the session behind a stoppable background row. The person's Stop or a
   * lowered grant aborts it at once: the caller hears why, and `work`'s signal fires.
   */
  async run<T>(
    session: GuestSession,
    work: GuestWork,
    signal: AbortSignal,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const engine = this.deps.engine();
    if (!engine) throw new TargetRefusal("unavailable", "Agents are starting on this machine.");
    signal.throwIfAborted();
    const id = this.deps.newId();
    const flight: Flight = { ...work, session, controller: new AbortController() };
    // The row opens first: a session the person deleted meanwhile refuses before anything runs.
    engine.guests.hold(session.threadId, `${prefix}${id}`, { title: clip(work.label, 200) });
    const abort = () => flight.controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    this.flights.set(id, flight);
    let status: "completed" | "failed" | "stopped" = "failed";
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        const fail = () => reject(this.refusal(flight));
        if (flight.controller.signal.aborted) fail();
        else flight.controller.signal.addEventListener("abort", fail, { once: true });
      });
      aborted.catch(() => undefined);
      const result = await Promise.race([task(flight.controller.signal), aborted]);
      status = "completed";
      return result;
    } catch (error) {
      if (flight.controller.signal.aborted) {
        status = "stopped";
        throw this.refusal(flight);
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      this.flights.delete(id);
      this.deps.engine()?.guests.hold(session.threadId, `${prefix}${id}`, { status });
    }
  }
  private refusal(flight: Flight): unknown {
    if (flight.why === "stopped")
      return new TargetRefusal("unavailable", "The person stopped it on that machine.");
    if (flight.why === "revoked")
      return new TargetRefusal(
        "machine_forbidden",
        "The person turned this off for agents from that machine.",
      );
    return flight.controller.signal.reason;
  }
  /** The person stopped one background row (`ace-guest:<id>`). */
  stop(id: string): void {
    this.end(id, "stopped");
  }
  /** The person stopped the whole session thread. */
  stopThread(threadId: string): void {
    for (const [id, flight] of this.flights)
      if (flight.session.threadId === threadId) this.end(id, "stopped");
  }
  /**
   * A grant went down, a device was revoked or the machine closed to agents: calls that need more
   * than `level` stop at once. Unset fields match every device or capability.
   */
  revoke(
    scope: { deviceId?: string; capability?: MachineCapability; level?: "off" | "read" } = {},
  ): void {
    for (const [id, flight] of this.flights) {
      if (scope.deviceId !== undefined && flight.session.deviceId !== scope.deviceId) continue;
      if (scope.capability && flight.capability !== scope.capability) continue;
      if (scope.level === "read" && flight.risk === "read") continue;
      this.end(id, "revoked");
    }
  }
  private end(id: string, why: "stopped" | "revoked") {
    const flight = this.flights.get(id);
    if (!flight || flight.controller.signal.aborted) return;
    flight.why = why;
    flight.controller.abort(new Error(why));
    for (const listener of this.ends)
      listener({ session: flight.session, capability: flight.capability, reason: why });
  }
  /** Hears work that ended early, so leases and screen sessions it held can be released. */
  onEnd(listener: (end: GuestEnd) => void): () => void {
    this.ends.add(listener);
    return () => this.ends.delete(listener);
  }
  /** Rows a previous process left running ended with it: mark them stopped. */
  recover(): void {
    const engine = this.deps.engine();
    if (!engine) return;
    const rows = this.deps.store
      .statement("SELECT thread_id FROM machine_threads WHERE kind='guest'")
      .all();
    for (const row of rows) {
      const threadId = ThreadId.parse(Row.parse(row).thread_id);
      for (const task of engine.guests.running(threadId, prefix))
        if (!this.flights.has(task.slice(prefix.length)))
          engine.guests.hold(threadId, task, { status: "stopped" });
    }
  }
}
