import { createHash } from "node:crypto";
import { z } from "zod";
import {
  Command,
  ThreadId,
  type CommandResult,
  type Device,
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
import { TargetRefusal } from "./target-refusal.ts";

export interface TargetThreadDeps {
  store: Store;
  engine(): Engine | undefined;
  journal(): DelegationJournal | undefined;
  now(): number;
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
  constructor(deps: TargetThreadDeps) {
    this.deps = deps;
    deps.store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS machine_threads (
        thread_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL,
        origin_host TEXT NOT NULL, origin_thread TEXT NOT NULL, created_at INTEGER NOT NULL)`),
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
          ? "Name a project from ace_machines."
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
  /** A retried request returns the same thread; the receipt makes creation run once. */
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
      return { threadId, title: existing.title };
    const workspaceId = this.project(call.project);
    const command = Command.parse({
      id: `machine-delegate:${key}`,
      deviceId: device.id,
      payload: {
        type: "thread.create",
        threadId,
        workspaceId,
        provider: call.provider,
        ...(call.model ? { model: call.model } : {}),
        mode: "local",
        title: clip(call.role, 256),
        trigger: "spawn",
        origin: { kind: "spawn", role: `machine:${origin.hostName}` },
        input: [
          {
            type: "text",
            text: `Task from ${origin.hostName} (thread "${clip(origin.threadTitle, 120)}"). Work in this project on this machine, then reply with a concise result.\n\n${call.task}`,
          },
        ],
      },
    });
    const result: CommandResult = this.deps.store.recordCommand(command.id, command.deviceId, () =>
      engine.internalHandler.handle(command, commandContext(this.deps.store)),
    );
    if (!result.ok)
      throw new TargetRefusal("unavailable", `This machine could not start it: ${result.error}`);
    this.record(device, threadId, "delegate", origin);
    return { threadId, title: this.deps.store.getThread(threadId)?.title ?? call.role };
  }
  cancel(device: Device, threadId: ThreadId) {
    const engine = this.deps.engine();
    if (!engine) throw new TargetRefusal("unavailable");
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
        title: "",
        elapsedSeconds: 0,
        status: { state: "done" },
        requests: [],
      };
    const root = thread.rootAgentId && store.getMcpAgent(thread.id, thread.rootAgentId);
    const rootIdle = !!root && ["idle", "blocked", "interrupted"].includes(root.status.state);
    const state = watchedState(thread, undefined, false, rootIdle);
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
  /** Open requests in the thread and its delegated descendants, oldest first. */
  private requests(thread: Thread): MachinePendingRequest[] {
    const { store } = this.deps;
    const ids = [...(thread.live?.asking ?? [])];
    const journal = this.deps.journal();
    for (const edge of journal?.family(thread.id) ?? []) {
      if (ids.length >= 8) break;
      if (journal?.isDescendant(edge.childId, thread.id))
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
    const page = store.readItemPage(thread.id, store.headSeq() + 1, 5, 16384);
    for (let index = page.items.length - 1; index >= 0; index--) {
      const item = page.items[index];
      if (item?.type !== "message" || item.role !== "assistant") continue;
      for (const part of item.parts.toReversed()) {
        const line = part.type === "text" ? lastLine(part.text, 160) : undefined;
        if (line) return line;
      }
    }
    return undefined;
  }
}
