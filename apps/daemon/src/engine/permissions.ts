import { ThreadId as importThreadId } from "@ace/protocol";
import { migratePermissionMode, nativePermissionModes } from "@ace/provider-kit/permission-modes";
import {
  Command,
  PermissionMode,
  type PermissionState,
  type ThreadId,
  type CommandResult,
  type Capabilities,
  type EventPayload,
  type PermissionReview,
} from "@ace/protocol";
import {
  reviewPermission,
  permissionDecisionOption,
  supportsPermissionMode,
  type Fact,
  type ThreadState,
} from "@ace/core";
import { z } from "zod";
import type { EngineRepository } from "./repository.ts";
import { permissionPaths, permissionShells, permissionCommands } from "./permission-paths.ts";

const Record = z.object({
  override: PermissionMode.nullable(),
  effective: PermissionMode.nullable(),
  parent: z.string().nullable(),
});
type Record = z.infer<typeof Record>;
export type PermissionSettings = (id: ThreadId) => Promise<PermissionMode | null>;
/** Durable policy ownership, independent of native provider settings and delegation journals. */
export class Permissions {
  private repo: EngineRepository;
  constructor(repo: EngineRepository) {
    this.repo = repo;
    repo.store.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS engine_permissions (
        thread_id TEXT PRIMARY KEY, override TEXT, effective TEXT, parent TEXT
      );
      CREATE TABLE IF NOT EXISTS engine_permission_reviews (
        interaction_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, review TEXT NOT NULL
      );
    `),
    );
    repo.store.atomic((db) => {
      const columns = z
        .array(z.object({ name: z.string(), notnull: z.number() }))
        .parse(db.prepare("PRAGMA table_info(engine_permissions)").all());
      if (columns.some((column) => column.name === "effective" && column.notnull === 1))
        db.exec(`ALTER TABLE engine_permissions RENAME TO engine_permissions_legacy;
        CREATE TABLE engine_permissions(thread_id TEXT PRIMARY KEY, override TEXT, effective TEXT, parent TEXT);
        INSERT INTO engine_permissions SELECT * FROM engine_permissions_legacy;
        DROP TABLE engine_permissions_legacy;`);
      for (const value of db.prepare("SELECT thread_id FROM engine_permissions").iterate()) {
        const row = z.object({ thread_id: z.string() }).parse(value);
        const id = importThreadId.parse(row.thread_id);
        const thread = repo.store.getThread(id);
        if (!thread) continue;
        const permission = this.state(id);
        const native = nativePermissionModes(thread.provider);
        const refresh = (capabilities: Capabilities | undefined): Capabilities | undefined => {
          if (!capabilities || capabilities.permissionModes) return capabilities;
          return {
            ...capabilities,
            permissionModes: native,
            ...(capabilities.permissions
              ? {
                  permissions: {
                    ...capabilities.permissions,
                    permissionModes: native,
                    modes: native.map((mode) => mode.id),
                    guarantees: undefined,
                  },
                }
              : {}),
          };
        };
        const capabilities = refresh(thread.capabilities);
        const effectiveCapabilities = refresh(thread.effectiveCapabilities);
        if (
          JSON.stringify(thread.permission) !== JSON.stringify(permission) ||
          capabilities !== thread.capabilities ||
          effectiveCapabilities !== thread.effectiveCapabilities
        )
          repo.store.appendEvents(
            id,
            [
              {
                type: "thread.updated",
                permission,
                ...(capabilities ? { capabilities } : {}),
                ...(effectiveCapabilities ? { effectiveCapabilities } : {}),
              },
            ],
            thread.updatedAt,
          );
      }
    });
  }
  private read(id: ThreadId): Record {
    const row = this.repo.store.atomic((db) =>
      db
        .prepare("SELECT override,effective,parent FROM engine_permissions WHERE thread_id=?")
        .get(id),
    );
    const record = row ? Record.parse(row) : { override: null, effective: null, parent: null };
    const provider =
      this.repo.state(id)?.config.provider ?? this.repo.store.getThread(id)?.provider;
    if (!provider) return record;
    const thread = this.repo.store.getThread(id);
    const advertised = (thread?.effectiveCapabilities ?? thread?.capabilities)?.permissionModes;
    const override = migratePermissionMode(provider, record.override, advertised);
    const effective = migratePermissionMode(provider, record.effective, advertised);
    if (override !== record.override || effective !== record.effective)
      this.repo.store.atomic((db) =>
        db
          .prepare("UPDATE engine_permissions SET override=?,effective=? WHERE thread_id=?")
          .run(override, effective, id),
      );
    return { ...record, override, effective };
  }
  ensure(
    id: ThreadId,
    override?: PermissionMode,
    provider?: import("@ace/protocol").ProviderKind,
    advertised?: import("@ace/protocol").NativePermissionMode[],
  ): PermissionState {
    const native = provider
      ? migratePermissionMode(provider, override, advertised)
      : (override ?? null);
    this.repo.store.atomic((db) =>
      db
        .prepare("INSERT OR IGNORE INTO engine_permissions VALUES (?,?,?,NULL)")
        .run(id, native, native),
    );
    return this.state(id);
  }
  effective(id: ThreadId): PermissionMode | null {
    return this.read(id).effective;
  }
  /** ace-owned Mac tools have their own manual consent, independent of the harness mode. */
  authority(_id: ThreadId): PermissionMode {
    return "ask";
  }
  state(id: ThreadId): PermissionState {
    const record = this.read(id);
    return {
      override: record.override,
      effective: record.effective,
      pending: record.override !== record.effective,
    };
  }
  parent(child: ThreadId, parent: ThreadId, _at: number): void {
    if (child === parent) throw new Error("Permission ancestry cycle");
    this.ensure(child);
    this.repo.store.atomic((db) =>
      db.prepare("UPDATE engine_permissions SET parent=? WHERE thread_id=?").run(parent, child),
    );
  }
  set(
    id: ThreadId,
    mode: PermissionMode | null,
    capabilities: Capabilities,
    at: number,
  ): string | undefined {
    mode = migratePermissionMode(
      this.repo.requireState(id).config.provider,
      mode,
      capabilities.permissionModes,
    );
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
  async resolve(
    id: ThreadId,
    settings?: PermissionSettings,
    nativeCapabilities?: Capabilities,
  ): Promise<PermissionMode | null> {
    const state = this.repo.requireState(id);
    const provider = state.config.provider;
    const configured = await settings?.(id);
    const record = this.read(id);
    const thread = this.repo.store.getThread(id);
    let selected = migratePermissionMode(
      provider,
      record.override ?? configured,
      (nativeCapabilities ?? thread?.effectiveCapabilities ?? thread?.capabilities)
        ?.permissionModes,
    );
    const capabilities =
      nativeCapabilities ?? thread?.effectiveCapabilities ?? thread?.capabilities;
    let remapped = false;
    if (selected && !supportsPermissionMode(capabilities?.permissions, selected)) {
      remapped = true;
      selected = migratePermissionMode(provider, configured, capabilities?.permissionModes);
      if (!supportsPermissionMode(capabilities?.permissions, selected)) selected = null;
    }
    if (record.override && (selected === null || remapped))
      this.repo.store.atomic((db) =>
        db.prepare("UPDATE engine_permissions SET override=NULL WHERE thread_id=?").run(id),
      );
    return selected;
  }
  applied(id: ThreadId, mode: PermissionMode | null, at: number): void {
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
      if (interaction.raw.some((raw) => raw.type === "ace.screen.approval")) continue;
      // save() has already published this frame. Use its identity index rather
      // than walking every pending approval for each newly opened approval.
      const key = this.repo.nativeEntity(state.threadId, "interactions", interaction.id);
      if (key === undefined || state.interactions[key]?.state !== "pending") continue;
      const target =
        interaction.request.kind === "approval" ? interaction.request.target : undefined;
      if (target?.origin !== "ace") continue;
      const mode = "ask";
      if (this.repo.reserved(interaction.id)) continue;
      const previous = this.repo.store.atomic((db) =>
        db
          .prepare("SELECT 1 FROM engine_permission_reviews WHERE interaction_id=?")
          .get(interaction.id),
      );
      if (previous) continue;
      let decision = reviewPermission({
        mode,
        ...(target ? { target } : {}),
        paths: permissionPaths(this.repo.session(state.threadId).cwd, target, (path) =>
          this.repo.attachments.canRead(state.threadId, path),
        ),
        trustedShells: permissionShells(this.repo.session(state.threadId).cwd, target),
        trustedCommands: permissionCommands(this.repo.session(state.threadId).cwd, target),
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
          text: `ace tool consent ${decision.decision}: ${decision.reason}`,
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
