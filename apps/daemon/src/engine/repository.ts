import { SessionMetadata } from "./session-metadata.ts";
import { syntheticInput, admitInput, removeInput } from "./transcript-inputs.ts";
import { cancelPending } from "./stop-intents.ts";
import { foldProviderFacts } from "./provider-facts.ts";
import { indexTitleInputs } from "./title-input.ts";
import { InteractionLedger } from "./interaction-ledger.ts";
import { InputJournal } from "./input-journal.ts";
import { attributeAceAction } from "./ace-approvals.ts";
import { AceInputs } from "./ace-inputs.ts";
import { Permissions } from "./permissions.ts";
import { ProviderRecovery } from "./provider-recovery.ts";
import type { ProviderBackend, Frame } from "@ace/engine-api";
import { z } from "zod";
import { boundedJson } from "@ace/provider-kit/ipc";
import { TransitionReadiness } from "./transition-readiness.ts";
import { captureExecutionSources } from "./execution-provenance.ts";
import { quiescent } from "./transition-history.ts";
import { TransitionState } from "./transition-state.ts";
import { type Fact, type ThreadState, type IdSource } from "@ace/core";
import type { StatementSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ExecutionOptions, Command, CommandId, ThreadId, type EventPayload } from "@ace/protocol";
import type { Store } from "../store.ts";
import { decodeSnapshot } from "./snapshot.ts";
import { readRawBlob } from "./raw.ts";
import { QueueStore } from "./queue-store.ts";
import { Snapshot } from "./persistence.ts";
import { migrateEngine } from "./migrations.ts";

import { IntentStore, type IntentHeader } from "./intents.ts";
export type { Intent, IntentHeader } from "./intents.ts";
export class EngineRepository {
  private aceAction: typeof import("@ace/mcp-server").aceToolAction | undefined;
  readonly store: Store;
  readonly aceInputs: AceInputs;
  readonly permissions: Permissions;
  readonly recovery: ProviderRecovery;
  private capture: StatementSync;
  private metadata: SessionMetadata;
  readonly queue: QueueStore;
  readonly inputs: InputJournal;
  readonly interactions: InteractionLedger;
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
    aceAction?: typeof import("@ace/mcp-server").aceToolAction,
  ) {
    this.aceAction = aceAction;
    this.capacity = capacity;
    this.commandId = commandId;
    this.ids = ids;
    this.store = store;
    this.metadata = new SessionMetadata(this);
    this.aceInputs = new AceInputs(store);
    store.atomic(migrateEngine);
    indexTitleInputs(store);
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
    this.inputs = new InputJournal(store);
    this.interactions = new InteractionLedger(store);
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
  attributeAction(state: ThreadState, fact: Fact): Fact {
    return attributeAceAction(state, fact, this.aceAction);
  }
  apply(id: ThreadId, facts: Fact[], now: number, generation?: number): ThreadState {
    try {
      return this.store.atomic(() => {
        const state = this.requireState(id);
        return foldProviderFacts(
          this,
          state,
          facts,
          now,
          {
            snapshot: this.snapshots.get(id),
            ids: this.ids,
            readiness: this.readiness,
            admission: this.admissionStatements,
            opening: this.opening.has(id),
            recoveryAcknowledged: () => this.recoveryAcknowledgement(id),
          },
          generation,
        );
      });
    } catch (error) {
      this.evict(id);
      throw error;
    }
  }

  syntheticInput(
    id: ThreadId,
    key: string,
    text: string,
    origin: import("@ace/protocol").MessageOrigin,
    at: number,
  ): void {
    syntheticInput(this, id, key, text, origin, at);
  }
  admitInput(command: Command, id: ThreadId, at: number): void {
    admitInput(this, command, id, at);
  }
  removeInput(id: ThreadId, commandId: CommandId, at: number): void {
    removeInput(this, id, commandId, at);
  }

  cancelPending(id: ThreadId, now: number): ThreadId[] {
    return cancelPending(this, id, now);
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
    this.pending.add(
      command,
      id,
      resolutionId,
      resolutionId ? this.interactions.owner(id, resolutionId) : undefined,
    );
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
  session(id: ThreadId) {
    return this.metadata.session(id);
  }
  createUnpreparedSession(
    id: ThreadId,
    cwd: string,
    model?: string,
    backend?: ProviderBackend,
    instanceId?: string,
    options?: ExecutionOptions,
  ): void {
    this.metadata.createUnpreparedSession(id, cwd, model, backend, instanceId, options);
  }
  createSession(
    id: ThreadId,
    cwd: string,
    model?: string,
    backend?: ProviderBackend,
    instanceId?: string,
    options?: ExecutionOptions,
  ): void {
    this.metadata.createSession(id, cwd, model, backend, instanceId, options);
  }
  nativeSession(
    id: ThreadId,
    nativeId: string,
    backend?: ProviderBackend,
    instanceId?: string,
  ): void {
    this.metadata.nativeSession(id, nativeId, backend, instanceId);
    this.interactions.bind(id);
  }
  pinSessionIdentity(
    id: ThreadId,
    identity: { backend: ProviderBackend; instanceId: string; nativeSessionId?: string },
  ): void {
    this.metadata.pinSessionIdentity(id, identity);
    this.interactions.bind(id);
  }
  backend(id: ThreadId): ProviderBackend | undefined {
    return this.metadata.backend(id);
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
