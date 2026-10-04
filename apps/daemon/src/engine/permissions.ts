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
  permissionAuthority,
  resolvePermissionMode,
  reviewPermission,
  permissionDecisionOption,
  supportsPermissionMode,
  type Fact,
  type ThreadState,
} from "@ace/core";
import { z } from "zod";
import type { EngineRepository } from "./repository.ts";
import { permissionPaths, permissionShells } from "./permission-paths.ts";

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
  authority(id: ThreadId): PermissionMode {
    return permissionAuthority(id, (key) => this.read(ThreadIdSchema.parse(key)));
  }
  state(id: ThreadId): PermissionState {
    const record = this.read(id);
    return {
      override: record.override,
      effective: record.effective,
      pending:
        record.override !== null &&
        limitPermissionMode(record.override, this.ceiling(id)) !== record.effective,
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
    const ceiling = this.authority(parent);
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
    return parent ? this.authority(ThreadIdSchema.parse(parent)) : undefined;
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
    const state = this.repo.requireState(id);
    if (state.config.provider !== "codex" && state.hasRun && !this.repo.quiescent(state))
      this.repo.apply(
        id,
        [
          {
            type: "item.upsert",
            agent: state.rootKey ?? "root",
            item: `permission-change:${this.repo.nextCommandId()}`,
            draft: {
              type: "notice",
              level: "info",
              code: "permission_change_pending",
              title: "Permission change queued",
              text: "Applies when the running command finishes",
              detail: "This provider needs a new session to apply its permission policy.",
              complete: true,
              raw: [
                {
                  type: "permission.pending",
                  data: { pending_reason: "busy", permissionMode: mode },
                },
              ],
            },
          },
        ],
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
        [{ type: "thread.updated", permission: this.state(id) }],
        at,
      );
    });
  }
  observe(state: ThreadState, events: EventPayload[], at: number, wake: () => void): void {
    const notices: Fact[] = [];
    for (const event of events) {
      if (event.type !== "interaction.opened" || event.interaction.request.kind !== "approval")
        continue;
      const interaction = event.interaction;
      // save() has already published this frame. Use its identity index rather
      // than walking every pending approval for each newly opened approval.
      const key = this.repo.nativeEntity(state.threadId, "interactions", interaction.id);
      if (key === undefined || state.interactions[key]?.state !== "pending") continue;
      const attributed = interaction.raw.find((raw) => raw.type === "ace.permission-policy");
      const parsed = z
        .object({ mode: PermissionMode })
        .safeParse(attributed && "data" in attributed ? attributed.data : undefined);
      // Only adapter-owned attribution can grant Full access to a Codex approval.
      const mode =
        state.config.provider === "codex"
          ? limitPermissionMode(
              parsed.success ? parsed.data.mode : "ask",
              this.ceiling(state.threadId),
            )
          : this.effective(state.threadId);
      if (mode === "ask") continue;
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
        trustedShells: permissionShells(this.repo.session(state.threadId).cwd, target),
      });
      const option = permissionDecisionOption(interaction.request, decision.decision);
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
      notices.push({
        type: "item.upsert",
        agent: state.indexes.agentKeysById[interaction.agentId] ?? state.rootKey ?? "root",
        item: `permission-review:${interaction.id}`,
        draft: {
          type: "notice",
          level: decision.decision === "approve" ? "info" : "warning",
          text:
            mode === "full-access" && decision.decision === "approve"
              ? "Approved · Full access"
              : `Permission review ${decision.decision}: ${decision.reason}`,
          complete: true,
          raw: [{ type: "permission.reviewed", data: review }],
        },
      });
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
    // Keep every review and notice in the caller's atomic transaction. Folding
    // each notice separately would re-derive the entire live tree per approval.
    if (notices.length) this.repo.apply(state.threadId, notices, at);
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
