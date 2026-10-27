import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AgentId,
  ProviderKind,
  ThreadId,
  type Device,
  type InteractionRequest,
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
  /** Deletes an idle session the way the person's Delete does, to make room for a new one. */
  remove(threadId: ThreadId): Promise<void>;
  /** Live sessions one calling device may hold here; default `sessionsPerDevice`. */
  perDevice?: number;
}

/** Live guest sessions one calling device may hold at once (ADR 0105). */
export const sessionsPerDevice = 64;
/** Session states with nothing running and nothing waiting on the person. */
const idleStates = new Set(["new", "done", "failed", "cancelled"]);
const Live = z.object({ thread_id: z.string() });

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
  /** The calling agent as leases here name it (`remote:<agent>`), with `threadId` making `owner`. */
  agent: AgentId;
}

/** What `run` is told about one call. */
export interface GuestWork {
  capability: MachineCapability;
  risk: Risk;
  /** The background row's words, e.g. "browser_open from Linux box". */
  label: string;
  /**
   * `ticket()` read before the call's grant was: a Stop on the session or a lowered grant since
   * then refuses the call even though it wasn't running yet when they came.
   */
  ticket: number;
}

/**
 * Whose remote work a revocation or the person's Stop covers. Unset fields match every device,
 * capability or session thread; `level` is what the capability still allows.
 */
export interface GuestScope {
  deviceId?: string;
  capability?: MachineCapability;
  level?: "off" | "read";
  threadId?: string;
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
/** Shell calls the commands host records in a session (ADR 0105). */
export const commandPrefix = "ace-command:";
const Row = z.object({ thread_id: z.string() });

/**
 * Guest sessions: one engine thread per (calling device, host, thread), in its own hidden chat
 * project, with no provider. Each call in flight holds a stoppable background row there, so the
 * person sees the work, can stop it, and the thread never reads done while it runs.
 */
export class GuestSessions {
  private deps: GuestSessionDeps;
  private opening = new Map<string, Promise<ThreadId>>();
  /** New sessions are made one at a time per calling device, so the bound holds. */
  private making = new Map<string, Promise<unknown>>();
  private flights = new Map<string, Flight>();
  private ends = new Set<(end: GuestEnd) => void>();
  private revokes = new Set<(scope: GuestScope) => void>();
  /** Counts Stops and revocations, so a call that is starting can tell it missed one. */
  private epoch = 0;
  private stops = new Map<string, number>();
  private revocations = new Map<string, number>();
  constructor(deps: GuestSessionDeps) {
    this.deps = deps;
  }
  /** Whether a thread here is a guest session. */
  guest(threadId: string): boolean {
    return this.deps.threads.owner(threadId)?.kind === "guest";
  }
  /** The request by that id waiting on the person in that thread, if there is one. */
  request(threadId: string, interactionId: string): InteractionRequest | undefined {
    const interaction = this.deps.store.getInteraction(interactionId);
    return interaction?.threadId === threadId && interaction.state === "pending"
      ? interaction.request
      : undefined;
  }
  /** Read before a call's grant is checked; see `GuestWork.ticket`. */
  ticket(): number {
    return this.epoch;
  }
  /** The calling thread's session, made on first use. Concurrent first calls share one. */
  async open(device: Device, origin: MachineCallOrigin): Promise<GuestSession> {
    const engine = this.deps.engine();
    if (!engine) throw new TargetRefusal("unavailable", "Agents are starting on this machine.");
    const key = JSON.stringify([device.id, origin.hostId, origin.threadId]);
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.find(device, origin) ?? this.serialized(device, origin, engine);
      this.opening.set(key, pending);
      void pending.finally(() => this.opening.delete(key)).catch(() => undefined);
    }
    const threadId = await pending;
    const agentId = engine.rootAgent(threadId);
    if (!agentId) throw new TargetRefusal("unavailable", "The session is not ready.");
    const agent = AgentId.parse(`remote:${origin.agentId ?? "agent"}`);
    return {
      threadId,
      agentId: AgentId.parse(agentId),
      deviceId: device.id,
      owner: agentOwner(threadId, agent),
      agent,
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
  private serialized(device: Device, origin: MachineCallOrigin, engine: Engine) {
    const before = this.making.get(device.id) ?? Promise.resolve();
    const made = before
      .catch(() => undefined)
      .then(
        () =>
          this.find(device, origin) ??
          this.makeRoom(device).then(() => this.create(device, origin, engine)),
      );
    this.making.set(device.id, made);
    void made
      .finally(() => {
        if (this.making.get(device.id) === made) this.making.delete(device.id);
      })
      .catch(() => undefined);
    return made;
  }
  /**
   * A calling device holds at most `perDevice` live sessions here. At the bound the least
   * recently active idle one is deleted, as the person's Delete would; when every one is busy
   * the new session is refused.
   */
  private async makeRoom(device: Device): Promise<void> {
    const limit = this.deps.perDevice ?? sessionsPerDevice;
    const live = this.deps.store
      .statement(
        `SELECT m.thread_id FROM machine_threads m JOIN threads t ON t.id=m.thread_id
         WHERE m.device_id=? AND m.kind='guest' AND json_extract(t.client,'$.deletedAt') IS NULL`,
      )
      .all(device.id)
      .flatMap((row) => {
        const thread = this.deps.store.getThread(ThreadId.parse(Live.parse(row).thread_id));
        return thread && thread.deletedAt === undefined ? [thread] : [];
      });
    if (live.length < limit) return;
    const busy = new Set([...this.flights.values()].map((flight) => flight.session.threadId));
    const idle = live
      .filter((thread) => idleStates.has(thread.status.state) && !busy.has(thread.id))
      .toSorted((a, b) => a.updatedAt - b.updatedAt);
    const over = live.length - limit + 1;
    if (idle.length < over)
      throw new TargetRefusal(
        "unavailable",
        `${device.name} already has ${limit} sessions working on this machine. Stop or delete one of them there, then try again.`,
      );
    for (const thread of idle.slice(0, over)) await this.deps.remove(thread.id);
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
    const missed = this.missed(flight);
    if (missed) this.end(id, missed);
    let status: "completed" | "failed" | "stopped" = "failed";
    try {
      if (flight.controller.signal.aborted) throw this.refusal(flight);
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
      this.settle(session.threadId, `${prefix}${id}`, status);
    }
  }
  /**
   * Ends a background row. A session the person deleted meanwhile has nowhere to record it, and
   * that never replaces what the call itself returned or threw.
   */
  private settle(threadId: ThreadId, task: string, status: "completed" | "failed" | "stopped") {
    const thread = this.deps.store.getThread(threadId);
    if (!thread || thread.deletedAt !== undefined) return;
    try {
      this.deps.engine()?.guests.hold(threadId, task, { status });
    } catch {
      // The thread went away between the check and the write; nothing is left to show.
    }
  }
  /** A Stop or revocation that came after the call's ticket and covers it. */
  private missed(flight: Flight): "stopped" | "revoked" | undefined {
    const after = (epoch: number | undefined) => epoch !== undefined && epoch > flight.ticket;
    if (after(this.stops.get(flight.session.threadId))) return "stopped";
    const levels = flight.risk === "operate" ? ["off", "read"] : ["off"];
    for (const device of [flight.session.deviceId, "*"])
      for (const capability of [flight.capability, "*"])
        for (const level of levels)
          if (after(this.revocations.get(JSON.stringify([device, capability, level]))))
            return "revoked";
    return undefined;
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
  /**
   * The person stopped one background row (`ace-guest:<id>`). A row with no call behind it (its
   * call ended without closing it) ends at once instead of staying running.
   */
  stop(id: string, threadId?: string): void {
    if (this.flights.has(id)) return this.end(id, "stopped");
    if (threadId === undefined) return;
    const thread = ThreadId.parse(threadId);
    // After the Stop command's own transaction, which is still open here.
    queueMicrotask(() => this.settle(thread, `${prefix}${id}`, "stopped"));
  }
  /** The person stopped or deleted the whole session thread. */
  stopThread(threadId: string): void {
    this.stops.set(threadId, ++this.epoch);
    for (const [id, flight] of this.flights)
      if (flight.session.threadId === threadId) this.end(id, "stopped");
    for (const listener of this.revokes) listener({ threadId });
  }
  /**
   * A grant went down, a device was revoked or the machine closed to agents: calls that need more
   * than `level` stop at once. Unset fields match every device or capability.
   */
  revoke(scope: Omit<GuestScope, "threadId"> = {}): void {
    const key = [scope.deviceId ?? "*", scope.capability ?? "*", scope.level ?? "off"];
    this.revocations.set(JSON.stringify(key), ++this.epoch);
    for (const [id, flight] of this.flights) {
      if (scope.deviceId !== undefined && flight.session.deviceId !== scope.deviceId) continue;
      if (scope.capability && flight.capability !== scope.capability) continue;
      if (scope.level === "read" && flight.risk === "read") continue;
      this.end(id, "revoked");
    }
    for (const listener of this.revokes) listener(scope);
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
  /**
   * Hears every revocation and every stopped session, idle or not, so what remote agents hold
   * (device leases, screen sessions) is released even when no call of theirs is running.
   */
  onRevoke(listener: (scope: GuestScope) => void): () => void {
    this.revokes.add(listener);
    return () => this.revokes.delete(listener);
  }
  /**
   * Work a previous process left running ended with it: its rows are marked stopped, and the
   * commands it was running (`ace-command:` shell calls) cancelled, so the session settles.
   */
  recover(): void {
    const engine = this.deps.engine();
    if (!engine) return;
    const rows = this.deps.store
      .statement("SELECT thread_id FROM machine_threads WHERE kind='guest'")
      .all();
    for (const row of rows) {
      const threadId = ThreadId.parse(Row.parse(row).thread_id);
      const thread = this.deps.store.getThread(threadId);
      if (!thread || thread.deletedAt !== undefined) continue;
      for (const task of engine.guests.running(threadId, prefix))
        if (!this.flights.has(task.slice(prefix.length)))
          engine.guests.hold(threadId, task, { status: "stopped" });
      engine.guests.endCommands(threadId, commandPrefix);
    }
  }
}
