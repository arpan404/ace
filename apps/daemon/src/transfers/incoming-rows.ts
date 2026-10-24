import { z } from "zod";
import {
  IncomingTransfer,
  IncomingTransferState,
  TransferBegin,
  TransferCommit,
  TransferMethod,
} from "@ace/protocol";
import type { Store } from "../store.ts";

const Row = z.object({
  transfer_id: z.string(),
  device_id: z.string(),
  state: IncomingTransferState,
  method: TransferMethod,
  has_origin: z.number().nullable(),
  begin: z.string(),
  commit_input: z.string().nullable(),
  workspace_id: z.string().nullable(),
  registered_id: z.string().nullable(),
  created_path: z.string().nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
type Row = z.infer<typeof Row>;

export interface IncomingRecord {
  transferId: string;
  deviceId: string;
  state: IncomingTransferState;
  method: TransferMethod;
  hasOrigin?: boolean | undefined;
  begin: TransferBegin;
  commit?: TransferCommit | undefined;
  /** method remote: the project reused for its origin. */
  workspaceId?: string | undefined;
  /** A project this transfer registered, unregistered again if the import fails. */
  registeredId?: string | undefined;
  /** A folder this transfer made, removed if the import fails before it registers. */
  createdPath?: string | undefined;
  result?: IncomingTransfer["result"];
  error?: IncomingTransfer["error"];
  updatedAt: number;
}

const decode = (row: Row): IncomingRecord => ({
  transferId: row.transfer_id,
  deviceId: row.device_id,
  state: row.state,
  method: row.method,
  ...(row.has_origin === null ? {} : { hasOrigin: row.has_origin === 1 }),
  begin: TransferBegin.parse(JSON.parse(row.begin)),
  ...(row.commit_input ? { commit: TransferCommit.parse(JSON.parse(row.commit_input)) } : {}),
  ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
  ...(row.registered_id ? { registeredId: row.registered_id } : {}),
  ...(row.created_path ? { createdPath: row.created_path } : {}),
  ...(row.result ? { result: IncomingTransfer.shape.result.parse(JSON.parse(row.result)) } : {}),
  ...(row.error ? { error: IncomingTransfer.shape.error.parse(JSON.parse(row.error)) } : {}),
  updatedAt: row.updated_at,
});

/** The target's durable rows, keyed by transfer id, so a repeated call is idempotent. */
export class IncomingRows {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS transfer_incoming (
        transfer_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, state TEXT NOT NULL,
        method TEXT NOT NULL, has_origin INTEGER, begin TEXT NOT NULL, commit_input TEXT,
        workspace_id TEXT, registered_id TEXT, created_path TEXT, result TEXT, error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    );
  }
  get(transferId: string): IncomingRecord | undefined {
    const raw = this.store
      .statement("SELECT * FROM transfer_incoming WHERE transfer_id=?")
      .get(transferId);
    return raw ? decode(Row.parse(raw)) : undefined;
  }
  /** Rows a restart left mid-import, to finish or roll back. */
  unsettled(): IncomingRecord[] {
    return this.store
      .statement(
        "SELECT * FROM transfer_incoming WHERE state IN ('cloning','importing') ORDER BY created_at LIMIT 64",
      )
      .all()
      .map((raw) => decode(Row.parse(raw)));
  }
  /** Settled rows older than `before`, for retention. */
  expired(before: number): IncomingRecord[] {
    return this.store
      .statement(
        "SELECT * FROM transfer_incoming WHERE updated_at<? AND state IN ('completed','failed','cancelled') LIMIT 64",
      )
      .all(before)
      .map((raw) => decode(Row.parse(raw)));
  }
  insert(record: IncomingRecord, at: number): void {
    this.store
      .statement(
        "INSERT INTO transfer_incoming (transfer_id,device_id,state,method,has_origin,begin,workspace_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        record.transferId,
        record.deviceId,
        record.state,
        record.method,
        record.hasOrigin === undefined ? null : record.hasOrigin ? 1 : 0,
        JSON.stringify(record.begin),
        record.workspaceId ?? null,
        at,
        at,
      );
  }
  update(
    transferId: string,
    change: Partial<Omit<IncomingRecord, "transferId" | "deviceId" | "begin" | "updatedAt">>,
    at: number,
  ): void {
    const columns: [string, unknown][] = [];
    if (change.state) columns.push(["state", change.state]);
    if (change.method) columns.push(["method", change.method]);
    if ("hasOrigin" in change)
      columns.push(["has_origin", change.hasOrigin === undefined ? null : change.hasOrigin ? 1 : 0]);
    if ("commit" in change)
      columns.push(["commit_input", change.commit ? JSON.stringify(change.commit) : null]);
    if ("workspaceId" in change) columns.push(["workspace_id", change.workspaceId ?? null]);
    if ("registeredId" in change) columns.push(["registered_id", change.registeredId ?? null]);
    if ("createdPath" in change) columns.push(["created_path", change.createdPath ?? null]);
    if ("result" in change)
      columns.push(["result", change.result ? JSON.stringify(change.result) : null]);
    if ("error" in change) columns.push(["error", change.error ? JSON.stringify(change.error) : null]);
    columns.push(["updated_at", at]);
    this.store
      .statement(
        `UPDATE transfer_incoming SET ${columns.map(([name]) => `${name}=?`).join(",")} WHERE transfer_id=?`,
      )
      .run(...columns.map(([, value]) => value as string | number | null), transferId);
  }
  delete(transferId: string): void {
    this.store.statement("DELETE FROM transfer_incoming WHERE transfer_id=?").run(transferId);
  }
}
