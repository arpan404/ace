import { AceInputs } from "./ace-inputs.ts";
import { coalesceFacts } from "./delta-batch.ts";
import { Permissions } from "./permissions.ts";
import { ProviderRecovery } from "./provider-recovery.ts";
import type { ProviderBackend, Frame } from "@ace/engine-api";
import { z } from "zod";
import { boundedJson } from "@ace/provider-kit/ipc";
import { TransitionReadiness } from "./transition-readiness.ts";
import { captureExecutionSources } from "./execution-provenance.ts";
import { quiescent } from "./transition-history.ts";
import { TransitionState } from "./transition-state.ts";
import { FactBatch, type Fact, type ThreadState, type IdSource } from "@ace/core";
import type { StatementSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ExecutionOptions, Command, CommandId, ThreadId, type EventPayload } from "@ace/protocol";
import type { Store } from "../store.ts";
import { decodeSnapshot } from "./snapshot.ts";
import { capFact, readRawBlob } from "./raw.ts";
import { QueueStore } from "./queue-store.ts";
import { Snapshot } from "./persistence.ts";
import { migrateEngine } from "./migrations.ts";

import { IntentStore, type IntentHeader } from "./intents.ts";
export type { Intent, IntentHeader } from "./intents.ts";
export class EngineRepository {
  readonly store: Store;
  readonly aceInputs: AceInputs;
  readonly permissions: Permissions;
  readonly recovery: ProviderRecovery;
  private capture: StatementSync;
  readonly queue: QueueStore;
  readonly pending: IntentStore;
  observe?: (state: ThreadState, facts: Fact[], events: EventPayload[], at: number) => void;
  private ids: IdSource;
  private capacity: number;
  private snapshotSeq = new WeakMap<Snapshot, number>();
  private commandId: () => string;
  private opening = new Set<ThreadId>();
  readonly transitions: TransitionState;
  private readiness: TransitionReadiness;
  private snapshots = new Map<ThreadId, Snapshot>();
  private admissionStatements: {
    has: StatementSync;
    mark: StatementSync;
    ack: StatementSync;
    correlated: StatementSync;
  };
  constructor(
    store: Store,
    ids: IdSource = { next: () => randomUUID() },
    capacity = 64,
    commandId: () => string = randomUUID,
  ) {
    this.capacity = capacity;
    this.commandId = commandId;
    this.ids = ids;
    this.store = store;
    this.aceInputs = new AceInputs(store);
    store.atomic(migrateEngine);
    store.atomic((db) =>
      db.exec(
        "CREATE INDEX IF NOT EXISTS engine_entity_ids ON engine_state_records(thread_id,section,json_extract(value,'$.id')) WHERE section IN ('interactions','tasks')",
      ),
    );
    this.permissions = new Permissions(this);
    store.atomic(() => store.workspaceReservations.initializeSessions());
    this.recovery = new ProviderRecovery(store);
    this.capture = store.atomic((_db) =>
      this.store.statement("INSERT OR IGNORE INTO engine_provider_frames VALUES (?,?,?,?)"),
    );
    this.queue = new QueueStore(store);
    this.pending = new IntentStore(store, this.queue);
    this.transitions = new TransitionState(store);
    this.readiness = store.atomic((_db) => new TransitionReadiness(_db));
    store.atomic((_db) => _db.exec("DELETE FROM engine_slots"));
    this.admissionStatements = store.atomic((_db) => ({
      has: this.store.statement(
        "SELECT 1 FROM engine_state_records WHERE thread_id=? AND section='engineAdmission' AND key='root'",
      ),
      mark: this.store.statement(
        "INSERT OR IGNORE INTO engine_state_records VALUES (?, 'engineAdmission', 'root', 'true')",
      ),
      correlated: this.store.statement(
        `UPDATE intents SET awaiting=0, acknowledged=1 WHERE thread_id=? AND command_id=? AND awaiting=1 RETURNING id`,
      ),
      ack: this.store
        .statement(`UPDATE intents SET awaiting=0, acknowledged=1 WHERE thread_id=? AND awaiting=1 AND ack_target=(
        SELECT ack_target FROM intents WHERE thread_id=? AND awaiting=1 ORDER BY id LIMIT 1
      ) RETURNING id`),
    }));
  }
  nextCommandId() {
    return CommandId.parse(this.commandId());
  }
  beginSessionOpen(id: ThreadId): void {
    this.opening.add(id);
  }
  resetAdmission(id: ThreadId): void {
    this.store.atomic((_db) =>
      this.store
        .statement(
          "DELETE FROM engine_state_records WHERE thread_id=? AND section='engineAdmission' AND key='root'",
        )
        .run(id),
    );
  }
  finishSessionOpen(id: ThreadId): void {
    this.opening.delete(id);
  }
  private recoveryAcknowledgement(id: ThreadId): boolean {
    return !this.opening.has(id) && this.pending.recoveryAcknowledgement(id);
  }
  state(id: ThreadId): ThreadState | undefined {
    return this.store.atomic((_db) => {
      const row = this.store
        .statement("SELECT state,seq FROM thread_state WHERE thread_id = ?")
        .get(id);
      if (!row) {
        this.snapshots.delete(id);
        return undefined;
      }
      let snapshot = this.snapshots.get(id);
      if (!snapshot || this.snapshotSeq.get(snapshot) !== Number(row.seq)) {
        snapshot = new Snapshot(
          { prepare: (sql) => this.store.statement(sql) },
          decodeSnapshot(String(row.state)),
        );
        this.snapshotSeq.set(snapshot, Number(row.seq));
      }
      this.snapshots.delete(id);
      this.snapshots.set(id, snapshot);
      this.trim();
      return snapshot.state;
    });
  }
  deadline(id: ThreadId, providerDeadline?: number): number | undefined {
    this.requireState(id);
    return this.snapshots.get(id)?.deadline(providerDeadline);
  }
  evict(id: ThreadId): void {
    this.snapshots.delete(id);
  }
  requireState(id: ThreadId): ThreadState {
    const state = this.state(id);
    if (!state) throw new Error("Missing engine state");
    return state;
  }
  *states(): Iterable<ThreadState> {
    const ids = this.store.atomic((_db) =>
      this.store
        .statement("SELECT thread_id FROM thread_state")
        .all()
        .map((row) => ThreadId.parse(row.thread_id)),
    );
    for (const id of ids) yield this.requireState(id);
  }
  save(state: ThreadState, payloads: EventPayload[], at: number): void {
    this.store.atomic((_db) => {
      let snapshot = this.snapshots.get(state.threadId);
      if (!snapshot || snapshot.state !== state)
        snapshot = new Snapshot({ prepare: (sql) => this.store.statement(sql) }, state);
      if (
        payloads.some(
          (event) =>
            event.type === "run.started" ||
            event.type === "item.created" ||
            event.type === "item.updated",
        )
      ) {
        const session = this.session(state.threadId);
        const selection = this.transitions.get(state.threadId).selection ?? {
          provider: state.config.provider,
          options: {},
          ...session,
        };
        captureExecutionSources(state, payloads, selection, session.nativeSessionId);
      }
      this.readiness.capture(state, payloads);
      snapshot.retainChanges(payloads);
      this.store.appendEvents(state.threadId, payloads, at);
      this.store
        .statement(`INSERT INTO thread_state VALUES (?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state, seq=excluded.seq`)
        .run(state.threadId, snapshot.header(), this.store.headSeq());
      snapshot.flush();
      this.snapshotSeq.set(snapshot, this.store.headSeq());
      this.snapshots.set(state.threadId, snapshot);
      this.trim();
    });
  }
  private trim(): void {
    if (this.snapshots.size > this.capacity) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest !== undefined) this.snapshots.delete(oldest);
    }
  }
  apply(id: ThreadId, facts: Fact[], now: number): ThreadState {
    try {
      return this.store.atomic(() => {
        const state = this.state(id);
        if (!state) throw new Error("Missing engine state");
        this.snapshots.get(id)?.begin();
        const batch = new FactBatch(state);
        let continuationStarted = false;
        const events = coalesceFacts(facts).flatMap((input) => {
          const queue = input.type === "turn.started" ? this.queue.get(id) : undefined;
          if (
            input.type === "turn.started" &&
            input.agent === (state.rootKey ?? "root") &&
            queue?.trigger &&
            this.recoveryAcknowledgement(id)
          )
            input = { ...input, trigger: queue.trigger };
          let fact = capFact(
            (raw) => this.store.capRaw(raw, id),
            this.aceInputs.attribute(id, input),
          );
          if (fact.type === "turn.started" && fact.agent === (state.rootKey ?? "root")) {
            const pending = this.pending.awaiting(id);
            if (
              pending &&
              (pending.kind === "thread.create" || pending.kind === "thread.send") &&
              pending.trigger
            )
              fact = { ...fact, trigger: pending.trigger };
          }
          if (fact.type === "turn.ended" && fact.agent === (state.rootKey ?? "root")) {
            const record = state.agents[fact.agent];
            const runId = fact.nativeTurnId
              ? record?.nativeRuns?.[fact.nativeTurnId]
              : record?.activeRun;
            const run = runId ? state.runs[runId] : undefined;
            if (
              run &&
              ["spawn", "parent_agent", "subagent_result", "schedule"].includes(run.trigger)
            )
              fact = { ...fact, trigger: run.trigger };
          }
          if (fact.type === "interaction.closed" && fact.state === "resolved") {
            const interaction = Object.hasOwn(state.interactions, fact.interaction)
              ? state.interactions[fact.interaction]
              : undefined;
            const answer = interaction ? this.answer(interaction.id) : undefined;
            if (answer?.payload.type === "interaction.resolve")
              fact = {
                ...fact,
                resolution: answer.payload.resolution,
                resolvedBy: answer.deviceId,
              };
          }
          const snapshot = this.snapshots.get(id);
          const finish = snapshot?.prepare(fact) ?? (() => {});
          try {
            const emitted = batch.apply(fact, {
              now,
              ids: this.ids,
              ...(fact.type === "turn.ended"
                ? {
                    resolvingInteractions: this.pending.resolvingInteractions(id),
                  }
                : {}),
            });
            if (
              fact.type === "turn.started" &&
              (fact.trigger === "restart" || fact.trigger === "limit_resume") &&
              emitted.some((event) => event.type === "run.started")
            )
              continuationStarted = true;
            if (fact.type === "item.delta" && emitted.some((event) => event.type === "item.delta"))
              snapshot?.delta(fact);
            snapshot?.remember(fact, emitted);
            if (fact.type === "tick") this.readiness.refreshBlocked(state);
            return emitted;
          } finally {
            finish();
          }
        });
        events.push(...batch.flush());
        // Admission-based providers transfer queue ownership before a run starts.
        // Persist the acknowledgement policy in the existing per-thread record store,
        // so a later run cannot acknowledge the next, unrelated engine input.
        const root = state.agents[state.rootKey ?? ""]?.agent.id;
        for (const event of events) {
          const admitted =
            event.type === "input.admitted" && event.agentId === root && !this.opening.has(id);
          if (admitted) this.admissionStatements.mark.run(id);
          const started =
            event.type === "run.started" &&
            !this.opening.has(id) &&
            event.run.agentId === root &&
            [
              "user",
              "queue",
              "unknown",
              "spawn",
              "parent_agent",
              "subagent_result",
              "schedule",
              "restart",
              "limit_resume",
            ].includes(event.run.trigger) &&
            !this.admissionStatements.has.get(id);
          const acknowledged =
            event.type === "input.admitted" && admitted && event.commandId !== undefined
              ? this.admissionStatements.correlated.all(id, event.commandId)
              : admitted || started
                ? this.admissionStatements.ack.all(id, id)
                : [];
          for (const row of acknowledged) this.queue.prune(Number(row.id));
        }
        if (continuationStarted && this.queue.get(id).trigger) {
          this.queue.set(id, { continuation: null, trigger: null }, now);
          this.pending.finishContinuation(id);
        }
        this.snapshots.get(id)?.updateDeadlines(facts, events, now);
        this.save(state, events, now);
        this.observe?.(state, facts, events, now);
        return state;
      });
    } catch (error) {
      this.evict(id);
      throw error;
    }
  }

  cancelPending(id: ThreadId, now: number): ThreadId[] {
    return this.store.atomic((_db) => {
      const released = new Set<ThreadId>();
      for (const intent of this.pending.headers(id)) {
        if (!["pending", "queued"].includes(intent.status)) continue;
        const kind = intent.kind;
        if (kind !== "thread.switch" && kind !== "thread.merge") continue;
        this.mark(intent, "failed", "Cancelled before delivery");
        for (const thread of this.transitions.releaseGuards(intent.commandId)) released.add(thread);
        if (kind === "thread.switch") {
          const pending = this.store.getThread(id)?.switch;
          if (pending)
            this.store.appendEvents(
              id,
              [
                {
                  type: "thread.updated",
                  switch: {
                    ...pending,
                    state: "failed",
                    error: "Cancelled before delivery",
                    at: now,
                  },
                },
              ],
              now,
            );
        }
      }
      // Fork intents belong to their new thread, never to the lineage source.
      for (const intent of this.pending.headers(id)) {
        if (intent.kind !== "thread.fork" || intent.status === "running") continue;
        for (const thread of this.transitions.releaseGuards(intent.commandId)) released.add(thread);
      }
      this.store
        .statement(
          "UPDATE intents SET status='failed', awaiting=0, error='Cancelled before delivery' WHERE thread_id=? AND kind IN ('thread.send','thread.create','thread.fork') AND (status IN ('pending','queued','running') OR awaiting=1)",
        )
        .run(id);
      for (const intent of this.pending.headers(id))
        if (this.cancelled(intent.id)) this.queue.prune(intent.id);
      this.queue.set(id, {}, now);
      return [...released];
    });
  }
  cancelled(intentId: number): boolean {
    return this.store.atomic(
      (_db) =>
        this.store
          .statement(
            "SELECT 1 FROM intents WHERE id=? AND status='failed' AND error='Cancelled before delivery'",
          )
          .get(intentId) !== undefined,
    );
  }
  quiescent(state: ThreadState): boolean {
    return quiescent(state, this.readiness.agentsReady(state));
  }

  add(command: Command, id: ThreadId, resolutionId?: string): void {
    this.pending.add(command, id, resolutionId);
  }
  reserve(id: ThreadId): boolean {
    return this.store.atomic((_db) => {
      if (this.store.statement("SELECT thread_id FROM engine_slots WHERE thread_id=?").get(id))
        return true;
      const count = Number(
        this.store.statement("SELECT COUNT(*) AS count FROM engine_slots").get()?.count,
      );
      if (count >= this.capacity) return false;
      this.store.statement("INSERT INTO engine_slots VALUES (?)").run(id);
      return true;
    });
  }
  release(id: ThreadId): void {
    this.store.atomic((_db) =>
      this.store.statement("DELETE FROM engine_slots WHERE thread_id=?").run(id),
    );
  }
  reservedSlot(id: ThreadId): boolean {
    return this.store.atomic((_db) =>
      Boolean(this.store.statement("SELECT thread_id FROM engine_slots WHERE thread_id=?").get(id)),
    );
  }
  readRawBlob(id: string): Uint8Array | undefined {
    return this.store.atomic((_db) => readRawBlob(_db, id));
  }
  nativeEntity(
    id: ThreadId,
    section: "interactions" | "tasks",
    entityId: string,
  ): string | undefined {
    const row = this.store
      .statement(
        "SELECT key FROM engine_state_records WHERE thread_id=? AND section=? AND section IN ('interactions','tasks') AND json_extract(value,'$.id')=? LIMIT 1",
      )
      .get(id, section, entityId);
    return row ? String(row.key) : undefined;
  }
  entityThread(collection: "interactions" | "backgroundTasks", id: string): ThreadId | undefined {
    const row = this.store
      .statement("SELECT thread_id FROM view_entities WHERE collection=? AND id=? LIMIT 1")
      .get(collection, id);
    return row ? ThreadId.parse(row.thread_id) : undefined;
  }
  answer(id: string): Command | undefined {
    return this.store.atomic((_db) => {
      const row = this.store
        .statement("SELECT payload FROM intents WHERE resolution_id = ?")
        .get(id);
      return row ? Command.parse(JSON.parse(String(row.payload))) : undefined;
    });
  }
  reserved(id: string): boolean {
    return this.store.atomic((_db) =>
      Boolean(this.store.statement("SELECT id FROM intents WHERE resolution_id = ?").get(id)),
    );
  }
  sessionOpening(id: ThreadId): boolean {
    return this.opening.has(id);
  }
  queuedCount(id: ThreadId): number {
    return this.store.atomic((_db) =>
      Number(
        this.store
          .statement(
            "SELECT (SELECT COUNT(*) FROM intents WHERE thread_id=? AND (status IN ('pending','queued') OR uncertain=1) AND kind IN ('thread.send','thread.create','thread.fork','thread.switch','thread.merge')) + (SELECT COUNT(DISTINCT ack_target) FROM intents WHERE thread_id=? AND awaiting=1 AND status<>'queued') + (SELECT COUNT(*) FROM engine_queue q WHERE q.thread_id=? AND q.continuation IS NOT NULL AND NOT EXISTS(SELECT 1 FROM intents i WHERE i.thread_id=q.thread_id AND i.kind IN ('thread.resume','queue.resume','thread.limit') AND i.awaiting=1)) AS count",
          )
          .get(id, id, id)?.count,
      ),
    );
  }
  inputCapacity(id: ThreadId, limit: number): boolean {
    // Both branches use existing live-intent indexes, with output bounded by admission capacity.
    return this.store.atomic(
      (_db) =>
        this.store
          .statement(`SELECT id FROM intents WHERE thread_id=? AND kind IN ('thread.create','thread.send')
        AND status IN ('pending','queued','running')
        UNION ALL SELECT id FROM intents WHERE thread_id=? AND kind IN ('thread.create','thread.send')
        AND awaiting=1 AND status NOT IN ('pending','queued','running') LIMIT ?`)
          .all(id, id, limit).length < limit,
    );
  }
  claim(intent: IntentHeader) {
    return this.pending.claim(intent);
  }
  beginSend(intent: IntentHeader, target: number | undefined): void {
    this.pending.beginSend(intent, target);
  }
  mark(intent: IntentHeader, status: string, error?: string): void {
    this.pending.mark(intent, status, error);
  }
  workspace(id: string): string | undefined {
    return this.store.atomic((_db) => {
      const row = this.store.statement("SELECT path FROM workspaces WHERE id = ?").get(id);
      return row ? String(row.path) : undefined;
    });
  }
  session(id: ThreadId): {
    cwd: string;
    model?: string;
    nativeSessionId?: string;
    backend?: ProviderBackend;
    instanceId?: string;
    workspaceReady: boolean;
    options?: ExecutionOptions;
  } {
    return this.store.atomic((_db) => {
      const row = this.store.statement("SELECT * FROM engine_sessions WHERE thread_id = ?").get(id);
      if (!row) throw new Error("Missing engine session metadata");
      return {
        cwd: String(row.cwd),
        ...(row.backend == null
          ? {}
          : { backend: z.enum(["acp", "cursor-sdk"]).parse(row.backend) }),
        ...(row.instance_id == null
          ? {}
          : { instanceId: z.string().min(1).max(256).parse(row.instance_id) }),
        workspaceReady: row.workspace_ready === 1,
        ...(row.options == null
          ? {}
          : { options: ExecutionOptions.parse(JSON.parse(String(row.options))) }),
        ...(row.model === null ? {} : { model: String(row.model) }),
        ...(row.native_session_id === null
          ? {}
          : { nativeSessionId: String(row.native_session_id) }),
      };
    });
  }
  createUnpreparedSession(
    id: ThreadId,
    cwd: string,
    model?: string,
    backend?: ProviderBackend,
    instanceId?: string,
    options?: ExecutionOptions,
  ): void {
    this.createSession(id, cwd, model, backend, instanceId, options);
    this.store.atomic((_db) =>
      this.store
        .statement("UPDATE engine_sessions SET workspace_ready=0 WHERE thread_id=?")
        .run(id),
    );
  }
  createSession(
    id: ThreadId,
    cwd: string,
    model?: string,
    backend?: ProviderBackend,
    instanceId?: string,
    options?: ExecutionOptions,
  ): void {
    this.store.atomic((_db) =>
      this.store
        .statement(
          "INSERT INTO engine_sessions (thread_id,cwd,model,native_session_id,backend,instance_id,options) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        )
        .run(
          id,
          cwd,
          model ?? null,
          backend ?? null,
          instanceId ?? null,
          options ? JSON.stringify(options) : null,
        ),
    );
  }
  nativeSession(
    id: ThreadId,
    nativeId: string,
    backend?: ProviderBackend,
    instanceId?: string,
  ): void {
    this.store.atomic((_db) => {
      this.store
        .statement(
          "UPDATE engine_sessions SET native_session_id = ?, backend = COALESCE(?,backend), instance_id = COALESCE(?,instance_id) WHERE thread_id = ?",
        )
        .run(nativeId, backend ?? null, instanceId ?? null, id);
      const thread = this.store.getThread(id);
      if (thread && instanceId && thread.live?.account !== instanceId)
        this.store.appendEvents(id, [
          {
            type: "thread.client.updated",
            changes: { live: { ...thread.live, account: instanceId } },
          },
        ]);
    });
  }
  pinSessionIdentity(
    id: ThreadId,
    identity: {
      backend: ProviderBackend;
      instanceId: string;
      nativeSessionId?: string;
    },
  ): void {
    this.store.atomic((_db) => {
      const before = this.session(id);
      if (
        (before.backend && before.backend !== identity.backend) ||
        (before.instanceId && before.instanceId !== identity.instanceId) ||
        (before.nativeSessionId &&
          identity.nativeSessionId &&
          before.nativeSessionId !== identity.nativeSessionId)
      )
        throw new Error("Provider session identity conflicts with its durable binding");
      this.store
        .statement(`UPDATE engine_sessions SET backend=?, instance_id=?,
        native_session_id=COALESCE(?,native_session_id) WHERE thread_id=?`)
        .run(identity.backend, identity.instanceId, identity.nativeSessionId ?? null, id);
    });
  }
  backend(id: ThreadId): ProviderBackend | undefined {
    // Recovery and teardown also read the binding of a tombstoned thread. They must
    // not resolve its execution workspace, which intentionally rejects deleted threads.
    const backend = this.store.atomic((_db) => {
      const row = this.store
        .statement("SELECT backend FROM engine_sessions WHERE thread_id=?")
        .get(id);
      if (!row) throw new Error("Missing engine session metadata");
      return row.backend == null ? undefined : z.enum(["acp", "cursor-sdk"]).parse(row.backend);
    });
    if (backend) return backend;
    return this.requireState(id).config.provider === "cursor" ? "acp" : undefined;
  }
  captureFrame(id: ThreadId, frame: Frame): void {
    // The SDK channel is shared by providers. Only Cursor owns this checkpoint journal.
    if (
      frame.channel !== "sdk" ||
      this.requireState(id).config.provider !== "cursor" ||
      this.backend(id) !== "cursor-sdk"
    )
      return;
    const generation = z
      .object({ generation: z.string().min(1).max(512) })
      .parse(frame.data).generation;
    const blob = z
      .object({
        kind: z.literal("blob"),
        body: z.object({
          id: z.string(),
          offset: z.number(),
          text: z.string().optional(),
          done: z.boolean().optional(),
        }),
      })
      .safeParse(frame.data);
    // Shared raw storage already owns chunk bytes. Hydration needs only ordered provenance.
    const data = blob.success
      ? {
          ...z.object({}).loose().parse(frame.data),
          body: {
            id: blob.data.body.id,
            offset: blob.data.body.offset,
            done: blob.data.body.done,
            bytes: Buffer.byteLength(blob.data.body.text ?? ""),
          },
        }
      : frame.data;
    const json = boundedJson({
      seq: frame.seq,
      t: frame.t,
      dir: frame.dir,
      channel: frame.channel,
      data,
    });
    this.store.atomic(() => this.capture.run(id, generation, frame.seq, json));
  }
}
