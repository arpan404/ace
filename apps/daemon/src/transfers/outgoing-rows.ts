import { z } from "zod";
import {
  AgentId,
  CommandId,
  HostId,
  ProviderKind,
  ThreadId,
  Transfer,
  TransferPhase,
} from "@ace/protocol";
import type { Store } from "../store.ts";

/** What the sender decided while preparing, kept so a restart sends the same thing. */
export const TransferPlan = z.object({
  source: z.string(),
  name: z.string(),
  remote: z.object({ url: z.string(), normalized: z.string() }).optional(),
  branch: z.string().optional(),
  head: z.string().optional(),
  changes: z.object({ ref: z.string(), commit: z.string() }).optional(),
  /** The bundle or archive, once written, with what it holds. */
  file: z.object({ path: z.string(), bytes: z.number(), sha256: z.string() }).optional(),
  /** The bundle holds only what origin lacks. */
  incremental: z.boolean().optional(),
});
export type TransferPlan = z.infer<typeof TransferPlan>;

/** What was asked, as the command or the agent's tool call gave it. */
export const TransferRequest = z.object({
  hostId: HostId,
  profile: z.string(),
  parent: z.string().optional(),
  includeChanges: z.boolean(),
  provider: ProviderKind.optional(),
  model: z.string().optional(),
  /** A continuation: the new thread there, as the source thread's settings give it. */
  thread: z
    .object({
      title: z.string().max(256),
      mode: z.enum(["local", "worktree"]),
      provider: ProviderKind,
      model: z.string().optional(),
    })
    .optional(),
  /** Set when an agent started it: its thread holds the transfer like a background task. */
  agent: z
    .object({ threadId: ThreadId, agentId: AgentId, self: z.boolean().default(false) })
    .optional(),
});
export type TransferRequest = z.infer<typeof TransferRequest>;

export interface OutgoingRecord {
  transfer: Transfer;
  request: TransferRequest;
  plan?: TransferPlan | undefined;
  /** An agent's result was handed to its thread. */
  delivered: boolean;
}

const Row = z.object({
  transfer_id: z.string(),
  record: z.string(),
  request: z.string(),
  plan: z.string().nullable(),
  delivered: z.number(),
});

const decode = (raw: unknown): OutgoingRecord => {
  const row = Row.parse(raw);
  return {
    transfer: Transfer.parse(JSON.parse(row.record)),
    request: TransferRequest.parse(JSON.parse(row.request)),
    ...(row.plan ? { plan: TransferPlan.parse(JSON.parse(row.plan)) } : {}),
    delivered: row.delivered === 1,
  };
};

export const unsettledPhases: readonly TransferPhase[] = [
  "preparing",
  "cloning",
  "sending",
  "importing",
  "starting",
];

/** The sender's durable transfer rows (ADR 0099 "Reliability"). */
export class OutgoingRows {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS transfer_outgoing (
        transfer_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, phase TEXT NOT NULL,
        record TEXT NOT NULL, request TEXT NOT NULL, plan TEXT,
        delivered INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL)`),
    );
  }
  get(transferId: string): OutgoingRecord | undefined {
    const raw = this.store
      .statement("SELECT * FROM transfer_outgoing WHERE transfer_id=?")
      .get(transferId);
    return raw ? decode(raw) : undefined;
  }
  byCommand(commandId: CommandId): OutgoingRecord | undefined {
    const raw = this.store
      .statement("SELECT * FROM transfer_outgoing WHERE command_id=?")
      .get(commandId);
    return raw ? decode(raw) : undefined;
  }
  /** Running transfers and those updated since `since`, newest first. */
  list(since: number): OutgoingRecord[] {
    return this.store
      .statement(
        `SELECT * FROM transfer_outgoing WHERE phase IN (${unsettledPhases.map(() => "?").join(",")}) OR updated_at>=? ORDER BY started_at DESC LIMIT 100`,
      )
      .all(...unsettledPhases, since)
      .map(decode);
  }
  unsettled(): OutgoingRecord[] {
    return this.store
      .statement(
        `SELECT * FROM transfer_outgoing WHERE phase IN (${unsettledPhases.map(() => "?").join(",")}) ORDER BY started_at LIMIT 64`,
      )
      .all(...unsettledPhases)
      .map(decode);
  }
  /** Agents' settled transfers whose result their thread hasn't been given yet. */
  undelivered(): OutgoingRecord[] {
    return this.store
      .statement(
        `SELECT * FROM transfer_outgoing WHERE delivered=0 AND phase NOT IN (${unsettledPhases.map(() => "?").join(",")}) ORDER BY started_at LIMIT 64`,
      )
      .all(...unsettledPhases)
      .map(decode)
      .filter((record) => record.request.agent);
  }
  expired(before: number): OutgoingRecord[] {
    return this.store
      .statement(
        `SELECT * FROM transfer_outgoing WHERE updated_at<? AND phase NOT IN (${unsettledPhases.map(() => "?").join(",")}) LIMIT 64`,
      )
      .all(before, ...unsettledPhases)
      .map(decode);
  }
  insert(record: OutgoingRecord): void {
    const { transfer } = record;
    this.store
      .statement(
        "INSERT INTO transfer_outgoing (transfer_id,command_id,phase,record,request,plan,delivered,started_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        transfer.transferId,
        transfer.commandId,
        transfer.phase,
        JSON.stringify(transfer),
        JSON.stringify(record.request),
        record.plan ? JSON.stringify(record.plan) : null,
        record.request.agent ? 0 : 1,
        transfer.startedAt,
        transfer.updatedAt,
      );
  }
  save(transfer: Transfer, plan?: TransferPlan): void {
    this.store
      .statement(
        "UPDATE transfer_outgoing SET phase=?,record=?,plan=COALESCE(?,plan),updated_at=? WHERE transfer_id=?",
      )
      .run(
        transfer.phase,
        JSON.stringify(transfer),
        plan ? JSON.stringify(plan) : null,
        transfer.updatedAt,
        transfer.transferId,
      );
  }
  /** Forgets the written file, so a resend builds it again. */
  dropFile(transferId: string, plan: TransferPlan): void {
    const { file: _file, incremental: _incremental, ...rest } = plan;
    this.store
      .statement("UPDATE transfer_outgoing SET plan=? WHERE transfer_id=?")
      .run(JSON.stringify(rest), transferId);
  }
  markDelivered(transferId: string): void {
    this.store
      .statement("UPDATE transfer_outgoing SET delivered=1 WHERE transfer_id=?")
      .run(transferId);
  }
  delete(transferId: string): void {
    this.store.statement("DELETE FROM transfer_outgoing WHERE transfer_id=?").run(transferId);
  }
}
