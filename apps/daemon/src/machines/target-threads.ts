import { createHash } from "node:crypto";
import { isAgentProse } from "@ace/projection";
import { z } from "zod";
import {
  Command,
  CommandId,
  ThreadId,
  type CommandResult,
  type Device,
  type Event,
  type MachineCall,
  type MachineCallOrigin,
  type MachinePendingRequest,
  type MachineThreadView,
  type Thread,
  WorkspaceId,
} from "@ace/protocol";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import type { DelegationJournal } from "../agent-control/journal.ts";
import { commandContext } from "../commands.ts";
import { threadOutcome } from "../agent-control/results.ts";
import {
  agentStep,
  clip,
  elapsedSeconds,
  lastLine,
  requestPrompt,
  settledStates,
  watchedState,
} from "../agent-control/watch-view.ts";
import { messageArrival } from "../agent-control/message-arrival.ts";
import { deliveryNotice, noticeText } from "../agent-control/message-notices.ts";
import { TargetRefusal } from "./target-refusal.ts";
import { TargetLaunches } from "./target-launches.ts";
import { MessageRejections, messageKey } from "./target-rejections.ts";
import { queuedStatus, queuedStep, unlaunchedResult } from "../agent-control/child-status.ts";
import { accountModelName } from "../agent-control/models.ts";
import { AgentControlError } from "../agent-control/failure.ts";

export interface TargetThreadDeps {
  store: Store;
  engine(): Engine | undefined;
  /** This machine's model catalog, which a loosely written model name is matched against. */
  models?(): import("@ace/models").ModelCatalogApi | undefined;
  journal(): DelegationJournal | undefined;
  now(): number;
  /** This machine's running-children limit, read live; undefined is no limit. */
  limit(): number | undefined;
  schedule(ms: number, run: () => void): () => void;
  report(error: unknown): void;
}
type Delegate = Extract<MachineCall, { op: "delegate" }>;
const Owner = z.object({ device_id: z.string(), kind: z.enum(["delegate", "browser"]) });

/**
 * Threads a paired device's agents started on this machine. Ownership is per device: one
 * device can neither read nor answer another device's threads, and every thread stays an
 * ordinary thread here, attributed to the device and machine that asked for it.
 */
export class TargetThreads {
  private deps: TargetThreadDeps;
  private unsubscribe: () => void;
  /** First runs of delegated threads, which wait for a free slot instead of being refused. */
  readonly launches: TargetLaunches;
  /** Messages refused before they reached their thread, which no copy of can ever run. */
  readonly rejections: MessageRejections;
  constructor(deps: TargetThreadDeps) {
    this.deps = deps;
    deps.store.atomic((db) =>
      // The store's migrations own machine_threads (machine-tables.ts).
      db.exec(`CREATE TABLE IF NOT EXISTS machine_thread_notices (
        thread_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, code TEXT NOT NULL,
        text TEXT NOT NULL)`),
    );
    this.unsubscribe = deps.store.subscribe((events) => {
      for (const event of events) this.observe(event);
    });
    this.launches = new TargetLaunches(deps);
    this.rejections = new MessageRejections(deps.store, deps.now);
  }
  close() {
    this.unsubscribe();
    this.launches.close();
  }
  /**
   * A message from the other machine's parent that didn't go in as sent. Kept so that machine's
   * agents_status and parent hear of it through `view`, as they would for a local child.
   */
  private observe(event: Event) {
    const notice = deliveryNotice(event);
    const engine = this.deps.engine();
    if (!notice || !engine || !this.owner(event.threadId)) return;
    if (!engine.messageFacts(event.threadId, CommandId.parse(notice.commandId)).fromParent) return;
    const title = this.deps.store.getThread(event.threadId)?.title ?? "the child";
    this.deps.store.atomic((db) =>
      db
        .prepare("INSERT OR REPLACE INTO machine_thread_notices VALUES (?,?,?,?)")
        .run(
          event.threadId,
          notice.commandId,
          notice.code,
          noticeText(notice, title, event.threadId),
        ),
    );
  }
  /** The kept notice, until the message it is about has been delivered. */
  private notice(threadId: ThreadId) {
    const row = this.deps.store.atomic((db) =>
      db
        .prepare("SELECT command_id,code,text FROM machine_thread_notices WHERE thread_id=?")
        .get(threadId),
    );
    const engine = this.deps.engine();
    if (!row || !engine) return undefined;
    const kept = z
      .object({ command_id: z.string(), code: z.string(), text: z.string() })
      .parse(row);
    if (engine.inputFate(threadId, CommandId.parse(kept.command_id)).state === "delivered")
      return undefined;
    return { text: kept.text.slice(0, 400), commandId: kept.command_id, code: kept.code };
  }
  /** The parent's new message supersedes what it was told about an earlier one. */
  private forgetNotice(threadId: ThreadId) {
    this.deps.store.atomic((db) =>
      db.prepare("DELETE FROM machine_thread_notices WHERE thread_id=?").run(threadId),
    );
  }
  owner(threadId: string): z.infer<typeof Owner> | undefined {
    const row = this.deps.store.atomic((db) =>
      db.prepare("SELECT device_id,kind FROM machine_threads WHERE thread_id=?").get(threadId),
    );
    return row ? Owner.parse(row) : undefined;
  }
  /** Owned by this device, or delegated below a thread it owns. */
  owns(device: Device, threadId: string): boolean {
    if (this.owner(threadId)?.device_id === device.id) return true;
    const journal = this.deps.journal();
    const root = journal?.get(ThreadId.parse(threadId))?.rootId;
    return root !== undefined && this.owner(root)?.device_id === device.id;
  }
  record(
    device: Device,
    threadId: ThreadId,
    kind: "delegate" | "browser",
    origin: MachineCallOrigin,
  ) {
    this.deps.store.atomic((db) =>
      db
        .prepare("INSERT OR IGNORE INTO machine_threads VALUES (?,?,?,?,?,?)")
        .run(threadId, device.id, kind, origin.hostId, origin.threadId, this.deps.now()),
    );
    // Started by an agent elsewhere, it is still work on this machine: list it like any task.
    this.deps.store.appendEvents(threadId, [
      { type: "thread.client.updated", changes: { hasSentMessage: true } },
    ]);
  }
  project(name: string | undefined): WorkspaceId {
    const rows = this.deps.store.atomic((db) =>
      db
        .prepare(
          "SELECT id,name FROM workspaces WHERE NOT EXISTS(SELECT 1 FROM workspace_unregistered WHERE workspace_id=workspaces.id) ORDER BY rowid DESC LIMIT 64",
        )
        .all(),
    );
    const projects = z.array(z.object({ id: z.string(), name: z.string() })).parse(rows);
    const found =
      name === undefined
        ? projects.length === 1
          ? projects[0]
          : undefined
        : (projects.find((project) => project.id === name) ??
          projects.find((project) => project.name.toLowerCase() === name.toLowerCase()));
    if (!found)
      throw new TargetRefusal(
        "invalid",
        name === undefined
          ? "Name a project from machines."
          : `No project "${clip(name, 64)}" on this machine.`,
      );
    return WorkspaceId.parse(found.id);
  }
  projects(): { workspaceId: WorkspaceId; name: string }[] {
    const rows = this.deps.store.atomic((db) =>
      db
        .prepare(
          "SELECT id,name FROM workspaces WHERE NOT EXISTS(SELECT 1 FROM workspace_unregistered WHERE workspace_id=workspaces.id) ORDER BY rowid DESC LIMIT 32",
        )
        .all(),
    );
    return z
      .array(z.object({ id: z.string(), name: z.string() }))
      .parse(rows)
      .map((row) => ({ workspaceId: WorkspaceId.parse(row.id), name: row.name.slice(0, 256) }));
  }
  /**
   * A retried request returns the same thread; receipts make creation run once. The thread is
   * prepared first, so what can never run (no such project, provider or model) is refused at
   * once; its task then starts, or waits for a slot like a local child (ADR 0099).
   */
  delegate(device: Device, origin: MachineCallOrigin, call: Delegate) {
    const engine = this.deps.engine();
    if (!engine) throw new TargetRefusal("unavailable", "Agents are starting on this machine.");
    const key = createHash("sha256")
      .update(JSON.stringify([device.id, origin.hostId, origin.threadId, call.requestId]))
      .digest("hex")
      .slice(0, 32);
    const threadId = ThreadId.parse(`machine-${key}`);
    const existing = this.deps.store.getThread(threadId);
    if (existing && this.owner(threadId)?.device_id === device.id)
      return {
        threadId,
        title: existing.title,
        ...(this.launches.queued(threadId) ? { queued: true } : {}),
      };
    const workspaceId = this.project(call.project);
    const model = call.model ? this.modelNamed(call.provider, call.model) : undefined;
    const { store } = this.deps;
    return store.atomic(() => {
      const command = Command.parse({
        id: `machine-prepare:${key}`,
        deviceId: device.id,
        payload: {
          type: "thread.prepare",
          threadId,
          workspaceId,
          provider: call.provider,
          ...(model ? { model } : {}),
          mode: "local",
          title: clip(call.role, 256) || "Task",
        },
      });
      const result: CommandResult = store.recordCommand(command.id, command.deviceId, () =>
        engine.internalHandler.handle(command, commandContext(store)),
      );
      if (!result.ok)
        throw new TargetRefusal("unavailable", `This machine could not start it: ${result.error}`);
      this.record(device, threadId, "delegate", origin);
      let state: "started" | "queued";
      try {
        state = this.launches.launch({
          threadId,
          parent: { deviceId: device.id, hostId: origin.hostId, threadId: origin.threadId },
          role: `machine:${origin.hostName}`,
          text: `Task from ${origin.hostName} (thread "${clip(origin.threadTitle, 120)}"). Work in this project on this machine, then reply with a concise result.\n\n${call.task}`,
          task: call.task,
        });
      } catch (error) {
        // Rolls back the prepared thread: a refused child leaves nothing behind.
        const reason = error instanceof Error ? error.message : "launch failed";
        throw new TargetRefusal("unavailable", `This machine could not start it: ${reason}`);
      }
      return {
        threadId,
        title: store.getThread(threadId)?.title ?? call.role,
        ...(state === "queued" ? { queued: true } : {}),
      };
    });
  }
  /** A model the other machine named loosely ("opus 5.5"), as this machine's catalog id. */
  private modelNamed(provider: import("@ace/protocol").ProviderKind, name: string): string {
    const catalog = this.deps.models?.();
    if (!catalog) return name;
    try {
      return accountModelName(catalog, { provider }, name);
    } catch (error) {
      if (error instanceof AgentControlError)
        throw new TargetRefusal("invalid", error.publicDetail ?? error.message);
      throw error;
    }
  }
  cancel(device: Device, threadId: ThreadId) {
    const engine = this.deps.engine();
    if (!engine) throw new TargetRefusal("unavailable");
    // A child still waiting for a slot settles cancelled without ever running.
    if (this.launches.cancel(threadId)) return { ok: true };
    const command = Command.parse({
      id: `machine-cancel:${threadId}`,
      deviceId: device.id,
      payload: { type: "thread.interrupt", threadId, cascade: true },
    });
    const result = this.deps.store.recordCommand(command.id, command.deviceId, () =>
      engine.internalHandler.handle(command, commandContext(this.deps.store)),
    );
    return { ok: result.ok };
  }
  /**
   * The parent agent's follow-up for a thread it delegated here, as a local parent's: steer joins
   * a running turn where the provider steers, queue waits for the turn to end, restart stops the
   * thread first and puts this message ahead of anything queued. Keyed by requestId, so a retry
   * sends it once. The answer says how it arrives; one that never will is refused with why.
   */
  message(device: Device, call: Extract<MachineCall, { op: "message" }>) {
    const key = messageKey(device, call);
    // A copy that authenticated before its device was revoked or ran out is never admitted.
    if (!this.rejections.active(device)) throw new TargetRefusal("unauthorized");
    // Checked before anything is admitted: a refused request never runs, whenever a copy lands.
    const rejected = this.rejections.find(key);
    if (rejected) throw rejected;
    // Deletion is permanent, so no copy of a message to a deleted thread can ever run.
    const thread = this.deps.store.getThread(call.threadId);
    if (!thread || thread.deletedAt !== undefined)
      throw this.rejections.reject(
        device,
        call,
        new TargetRefusal("not_found", "Its thread was deleted on this machine."),
      );
    const engine = this.deps.engine();
    if (!engine) throw new TargetRefusal("unavailable", "Agents are starting on this machine.");
    try {
      return this.deliver(device, call, engine, key);
    } catch (error) {
      // Each refusal from here follows a step recorded under the request (the restart's stop, the
      // send, the queue move, the message's own fate), so every copy of the request gets the same
      // answer and none runs anew: the caller can stop sending it.
      if (error instanceof TargetRefusal) throw new TargetRefusal(error.code, error.message, true);
      throw error;
    }
  }
  /** The message itself: each step is recorded under the request, so a retry repeats its answer. */
  private deliver(
    device: Device,
    call: Extract<MachineCall, { op: "message" }>,
    engine: Engine,
    key: string,
  ) {
    const run = (id: string, payload: unknown): CommandResult => {
      const command = Command.parse({ id, deviceId: device.id, payload });
      return this.deps.store.recordCommand(command.id, command.deviceId, () =>
        engine.internalHandler.handle(command, commandContext(this.deps.store)),
      );
    };
    // The parent's own message starts a waiting child first, as it does for a local child.
    this.launches.startNow(call.threadId);
    const restart = call.delivery === "restart";
    if (restart) {
      // A cascading stop: what this thread delegated here stops with it, as in a local restart.
      const stopped = run(`machine-restart:${key}`, {
        type: "thread.interrupt",
        threadId: call.threadId,
        cascade: true,
      });
      if (!stopped.ok)
        throw new TargetRefusal("unavailable", `This machine could not stop it: ${stopped.error}`);
    }
    const id = CommandId.parse(`machine-message:${key}`);
    // New work reopens a child that settled before it ever ran: its old outcome goes in the
    // transaction that admits the work, so no poll can read it while the new work runs.
    const sent = this.deps.store.atomic(() => {
      const result = run(id, {
        type: "thread.send",
        threadId: call.threadId,
        input: [{ type: "text", text: call.text }],
        delivery: restart ? "queue" : call.delivery,
        trigger: "parent_agent",
      });
      if (result.ok) this.launches.reopen(call.threadId);
      return result;
    });
    if (!sent.ok)
      throw new TargetRefusal(
        "unavailable",
        `This machine did not take the message: ${sent.error}`,
      );
    this.forgetNotice(call.threadId);
    const queue = engine.queue(call.threadId);
    if (restart && queue.messages[0]?.id !== id) {
      const moved = run(`machine-restart-first:${key}`, {
        type: "queue.move",
        threadId: call.threadId,
        messageId: id,
        after: null,
        expectedRevision: queue.revision,
      });
      if (!moved.ok) throw new TargetRefusal("unavailable", "The restart message lost its place.");
    }
    const reading = messageArrival(engine.messageFacts(call.threadId, id), restart);
    if (!reading.ok) throw new TargetRefusal("invalid", reading.hint);
    return { arrival: reading.arrival };
  }
  /** The person's answer from another device goes through this machine's own consent owners. */
  respond(device: Device, call: Extract<MachineCall, { op: "respond" }>) {
    const engine = this.deps.engine();
    const interaction = this.deps.store.getInteraction(call.interactionId);
    if (!engine || !interaction || interaction.threadId !== call.threadId)
      throw new TargetRefusal("not_found", "That request is no longer open.");
    if (interaction.state !== "pending")
      throw new TargetRefusal("not_found", "That request was already answered.");
    const command = Command.parse({
      id: `machine-respond:${call.interactionId}`,
      deviceId: device.id,
      payload: {
        type: "interaction.resolve",
        interactionId: call.interactionId,
        resolution: call.resolution,
      },
    });
    const result = this.deps.store.recordCommand(command.id, command.deviceId, () =>
      engine.internalHandler.handle(command, commandContext(this.deps.store)),
    );
    if (!result.ok) throw new TargetRefusal("invalid", "That answer was not accepted.");
    return { ok: true };
  }
  view(threadId: ThreadId): MachineThreadView {
    const { store } = this.deps;
    const thread = store.getThread(threadId);
    if (!thread || thread.deletedAt !== undefined)
      return {
        threadId,
        state: "cancelled",
        title: thread ? clip(thread.title, 120) : "",
        elapsedSeconds: 0,
        status: { state: "done" },
        requests: [],
        result: "Its thread was deleted on that machine.",
        truncated: false,
      };
    const waiting = this.waitingView(thread);
    if (waiting) return waiting;
    const root = thread.rootAgentId && store.getMcpAgent(thread.id, thread.rootAgentId);
    const rootIdle = !!root && ["idle", "blocked", "interrupted"].includes(root.status.state);
    const state = watchedState(thread, undefined, false, rootIdle);
    const notice = this.notice(threadId);
    const settled = settledStates.has(state);
    const base = {
      threadId,
      state,
      title: clip(thread.title, 120),
      elapsedSeconds: elapsedSeconds(
        thread.createdAt,
        settled ? thread.updatedAt : this.deps.now(),
      ),
      status: thread.status,
      requests: this.requests(thread),
      ...(notice ? { notice } : {}),
    };
    if (settled) {
      const outcome = threadOutcome(store, thread, state === "cancelled");
      return { ...base, result: outcome.result, truncated: outcome.truncated };
    }
    const step = root ? agentStep(root.status) : undefined;
    const last = this.lastOutput(thread);
    return {
      ...base,
      ...(step ? { step: clip(step, 120) } : {}),
      ...(last ? { last } : {}),
      ...(base.requests.length
        ? {
            needs: base.requests.map((entry) => ({
              interactionId: entry.interactionId,
              kind: entry.request.kind,
              prompt: clip(requestPrompt(entry.request), 240),
            })),
          }
        : {}),
    };
  }
  /**
   * A thread whose task has not run: queued for a slot, which keeps the parent elsewhere open,
   * or settled before it started, which gives that parent its result.
   */
  private waitingView(thread: Thread): MachineThreadView | undefined {
    const base = {
      threadId: thread.id,
      title: clip(thread.title, 120),
      requests: [],
    };
    if (this.launches.queued(thread.id))
      return {
        ...base,
        state: "queued",
        elapsedSeconds: elapsedSeconds(thread.createdAt, this.deps.now()),
        status: queuedStatus,
        step: queuedStep,
      };
    // Work admitted since (a run starting clears the outcome) is never shown as the old outcome.
    const idle = ["new", "done", "failed"].includes(thread.status.state);
    const outcome = idle ? this.launches.unlaunched(thread.id) : undefined;
    if (!outcome) return undefined;
    return {
      ...base,
      state: outcome,
      elapsedSeconds: elapsedSeconds(thread.createdAt, thread.updatedAt),
      status: { state: outcome === "failed" ? "failed" : "done" },
      result: unlaunchedResult(outcome),
      truncated: false,
    };
  }
  /** Open requests in the thread and its delegated descendants, oldest first. */
  private requests(thread: Thread): MachinePendingRequest[] {
    const { store } = this.deps;
    const ids = [...(thread.live?.asking ?? [])];
    const journal = this.deps.journal();
    for (const edge of journal?.liveDescendants(thread.id) ?? []) {
      if (ids.length >= 8) break;
      ids.push(...(store.getThread(edge.childId)?.live?.asking ?? []));
    }
    return ids.slice(0, 8).flatMap((entry) => {
      const interaction = store.getInteraction(entry.id);
      return interaction?.state === "pending"
        ? [
            {
              threadId: interaction.threadId,
              interactionId: interaction.id,
              request: interaction.request,
            },
          ]
        : [];
    });
  }
  private lastOutput(thread: Thread): string | undefined {
    const { store } = this.deps;
    const page = store.readBoundedItemPage(thread.id, store.headSeq() + 1, 5, 16384);
    for (let index = page.items.length - 1; index >= 0; index--) {
      const item = page.items[index];
      if (!isAgentProse(item)) continue;
      for (const part of item.parts.toReversed()) {
        const line = part.type === "text" ? lastLine(part.text, 160) : undefined;
        if (line) return line;
      }
    }
    return undefined;
  }
}
