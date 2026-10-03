import {
  Command,
  PermissionMode,
  type PermissionState,
  ThreadId as ThreadIdSchema,
  type ThreadId,
  type CommandResult,
  type Capabilities,
  type EventPayload,
  type PermissionReview,
} from "@ace/protocol";
import {
  limitPermissionMode,
  resolvePermissionMode,
  reviewPermission,
  supportsPermissionMode,
  type ThreadState,
} from "@ace/core";
import { z } from "zod";
import type { EngineRepository } from "./repository.ts";
import { permissionPaths } from "./permission-paths.ts";

const Record = z.object({
  override: PermissionMode.nullable(),
  effective: PermissionMode,
  parent: z.string().nullable(),
});
type Record = z.infer<typeof Record>;
export type PermissionSettings = (id: ThreadId) => Promise<PermissionMode>;
/** Durable policy ownership, independent of native provider settings and delegation journals. */
export class Permissions {
  private repo: EngineRepository;
  constructor(repo: EngineRepository) {
    this.repo = repo;
    repo.store.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS engine_permissions (
        thread_id TEXT PRIMARY KEY, override TEXT, effective TEXT NOT NULL, parent TEXT
      );
      CREATE TABLE IF NOT EXISTS engine_permission_reviews (
        interaction_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, review TEXT NOT NULL
      );
    `),
    );
  }
  private read(id: ThreadId): Record {
    const row = this.repo.store.atomic((db) =>
      db
        .prepare("SELECT override,effective,parent FROM engine_permissions WHERE thread_id=?")
        .get(id),
    );
    return row ? Record.parse(row) : { override: null, effective: "auto-review", parent: null };
  }
  ensure(id: ThreadId, override?: PermissionMode): PermissionState {
    this.repo.store.atomic((db) =>
      db
        .prepare("INSERT OR IGNORE INTO engine_permissions VALUES (?,?,?,NULL)")
        .run(id, override ?? null, override ?? "auto-review"),
    );
    return this.state(id);
  }
  effective(id: ThreadId): PermissionMode {
    return this.read(id).effective;
  }
  state(id: ThreadId): PermissionState {
    const record = this.read(id);
    return {
      override: record.override,
      effective: record.effective,
      pending: record.override !== null && record.override !== record.effective,
    };
  }
  /** Host-only relationship. Never accept parent identity from an ordinary wire command. */
  parent(child: ThreadId, parent: ThreadId, at: number): void {
    if (child === parent) throw new Error("Permission ancestry cycle");
    let ancestor: string | null = parent;
    for (let depth = 0; ancestor !== null; depth++) {
      if (depth >= 64 || ancestor === child)
        throw new Error("Permission ancestry cycle or depth exceeded");
      ancestor = this.read(ThreadIdSchema.parse(ancestor)).parent;
    }
    this.ensure(child);
    const record = this.read(child);
    const ceiling = this.effective(parent);
    const effective = this.repo.state(child)?.hasRun
      ? limitPermissionMode(record.effective, ceiling)
      : resolvePermissionMode({ override: record.override, setting: ceiling, parent: ceiling });
    this.repo.store.atomic((db) =>
      db
        .prepare("UPDATE engine_permissions SET parent=?,effective=? WHERE thread_id=?")
        .run(parent, effective, child),
    );
    if (this.repo.store.getThread(child))
      this.repo.store.appendEvents(
        child,
        [{ type: "thread.updated", permission: this.state(child) }],
        at,
      );
  }
  private ceiling(id: ThreadId): PermissionMode | undefined {
    const parent = this.read(id).parent;
    return parent ? this.effective(ThreadIdSchema.parse(parent)) : undefined;
  }
  set(
    id: ThreadId,
    mode: PermissionMode | null,
    capabilities: Capabilities,
    at: number,
  ): string | undefined {
    const parent = this.ceiling(id);
    if (mode && limitPermissionMode(mode, parent) !== mode) return "permission_exceeds_parent";
    if (mode && !supportsPermissionMode(capabilities.permissions, mode))
      return "permission_mode_unsupported";
    this.ensure(id);
    this.repo.store.atomic((db) =>
      db.prepare("UPDATE engine_permissions SET override=? WHERE thread_id=?").run(mode, id),
    );
    this.repo.store.appendEvents(
      id,
      [{ type: "thread.updated", permission: { ...this.state(id), pending: true } }],
      at,
    );
    return undefined;
  }
  async resolve(id: ThreadId, settings?: PermissionSettings): Promise<PermissionMode> {
    const settingValue = await settings?.(id);
    const record = this.read(id);
    const parent = this.ceiling(id);
    const setting = parent ?? settingValue;
    return resolvePermissionMode({
      override: record.override,
      ...(setting ? { setting } : {}),
      ...(parent ? { parent } : {}),
    });
  }
  applied(id: ThreadId, mode: PermissionMode, at: number): void {
    this.ensure(id);
    this.repo.store.atomic(() => {
      this.repo.store.atomic((db) =>
        db.prepare("UPDATE engine_permissions SET effective=? WHERE thread_id=?").run(mode, id),
      );
      this.repo.store.appendEvents(
        id,
        [{ type: "thread.updated", permission: { ...this.state(id), pending: false } }],
        at,
      );
    });
  }
  observe(state: ThreadState, events: EventPayload[], at: number, wake: () => void): void {
    for (const event of events) {
      if (event.type !== "interaction.opened" || event.interaction.request.kind !== "approval")
        continue;
      const interaction = event.interaction;
      if (
        !Object.keys(state.indexes.pendingInteractions).some(
          (key) => state.interactions[key]?.id === interaction.id,
        )
      )
        continue;
      const mode = this.effective(state.threadId);
      if (mode === "full-access" || mode === "ask") continue;
      if (this.repo.reserved(interaction.id)) continue;
      const previous = this.repo.store.atomic((db) =>
        db
          .prepare("SELECT 1 FROM engine_permission_reviews WHERE interaction_id=?")
          .get(interaction.id),
      );
      if (previous) continue;
      const target =
        interaction.request.kind === "approval" ? interaction.request.target : undefined;
      let decision = reviewPermission({
        mode,
        ...(target ? { target } : {}),
        paths: permissionPaths(this.repo.session(state.threadId).cwd, target),
      });
      const option =
        interaction.request.kind === "approval"
          ? interaction.request.options.find((choice) =>
              decision.decision === "approve"
                ? choice.kind === "allow_once"
                : choice.kind === "deny",
            )
          : undefined;
      if (decision.decision !== "escalate" && !option)
        decision = {
          decision: "escalate",
          reason: "Provider offers no matching one-shot approval or denial",
        };
      const review: PermissionReview = {
        interactionId: interaction.id,
        mode,
        ...decision,
        reviewer: "ace-risk-policy",
        ...(target ? { target } : {}),
      };
      this.repo.store.atomic((db) =>
        db
          .prepare("INSERT INTO engine_permission_reviews VALUES (?,?,?)")
          .run(interaction.id, state.threadId, JSON.stringify(review)),
      );
      this.repo.store.appendEvents(state.threadId, [{ type: "permission.reviewed", review }], at);
      this.repo.apply(
        state.threadId,
        [
          {
            type: "item.upsert",
            agent: state.indexes.agentKeysById[interaction.agentId] ?? state.rootKey ?? "root",
            item: `permission-review:${interaction.id}`,
            draft: {
              type: "notice",
              level: decision.decision === "approve" ? "info" : "warning",
              text: `Permission review ${decision.decision}: ${decision.reason}`,
              complete: true,
              raw: [{ type: "permission.reviewed", data: review }],
            },
          },
        ],
        at,
      );
      if (decision.decision !== "escalate" && option) {
        const command = Command.parse({
          id: this.repo.nextCommandId(),
          deviceId: "ace-reviewer",
          payload: {
            type: "interaction.resolve",
            interactionId: interaction.id,
            resolution: { kind: "approval", optionId: option.id, message: decision.reason },
          },
        });
        this.repo.add(command, state.threadId, interaction.id);
        queueMicrotask(wake);
      }
    }
  }
  accept(command: Command, capabilities: Capabilities, at: number): CommandResult | undefined {
    const p = command.payload;
    if (p.type !== "thread.permission.set") return undefined;
    if (!this.repo.state(p.threadId))
      return { commandId: command.id, ok: false, error: "thread_not_found" };
    const error = this.set(p.threadId, p.permissionMode, capabilities, at);
    return { commandId: command.id, ok: !error, ...(error ? { error } : {}), threadId: p.threadId };
  }
}
