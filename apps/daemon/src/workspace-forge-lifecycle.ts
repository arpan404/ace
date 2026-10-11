import { z } from "zod";
import {
  ForgeHostedLifecycleCommand,
  ForgeLifecycleAction,
  ForgeLifecycleSnapshot,
  ForgeLifecycleReceipt,
  type ForgePrRef,
  type ForgeLifecycleState,
  type ForgeLifecycleReceipt as LifecycleReceipt,
} from "@ace/protocol";
import { ForgeError, type GitHubForge } from "@ace/forge";
import type { Store } from "./store.ts";
const scope = (pr: ForgePrRef) => JSON.stringify(pr);
/** Durable receipts plus a journal that observes uncertain remote results without repeating writes. */
export class WorkspaceForgeLifecycle {
  readonly #store: Store;
  constructor(store: Store) {
    this.#store = store;
    store.atomic((db) =>
      db.exec(
        `CREATE TABLE IF NOT EXISTS forge_lifecycle_writes (id TEXT PRIMARY KEY, scope TEXT NOT NULL, action TEXT NOT NULL, before TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT); CREATE INDEX IF NOT EXISTS forge_lifecycle_scope ON forge_lifecycle_writes(scope,state)`,
      ),
    );
  }
  async state(
    pr: ForgePrRef,
    backend: GitHubForge,
    signal: AbortSignal,
  ): Promise<ForgeLifecycleState> {
    const snapshot = await backend.lifecycle.snapshot(pr.number, signal);
    const rows = this.#store.atomic((db) =>
      db
        .prepare(
          "SELECT id,action,state,receipt FROM forge_lifecycle_writes WHERE scope=? ORDER BY rowid DESC LIMIT 100",
        )
        .all(scope(pr)),
    );
    const operations = rows.map((row) => {
      const action = ForgeLifecycleAction.parse(JSON.parse(z.string().parse(row.action)));
      const receipt =
        row.receipt === null
          ? undefined
          : ForgeLifecycleReceipt.parse(JSON.parse(z.string().parse(row.receipt)));
      return Object.assign(
        {
          id: z.string().parse(row.id),
          kind: action.kind,
          state: z.enum(["accepted", "pending", "uncertain", "head_changed"]).parse(row.state),
        },
        receipt?.revertPr ? { revertPr: receipt.revertPr } : {},
      );
    });
    return { snapshot, operations };
  }
  #record(id: string, receipt: LifecycleReceipt) {
    this.#store.atomic((db) =>
      db
        .prepare("UPDATE forge_lifecycle_writes SET state=?,receipt=? WHERE id=?")
        .run(receipt.outcome, JSON.stringify(receipt), id),
    );
  }
  async execute(
    input: unknown,
    commandId: string,
    backend: GitHubForge,
    signal: AbortSignal,
    allowed: () => boolean,
  ): Promise<LifecycleReceipt> {
    const { pr, operation } = ForgeHostedLifecycleCommand.parse(input);
    if (!allowed() || signal.aborted) throw new ForgeError("cancelled");
    if (operation.kind === "reconcile") {
      const row = this.#store.atomic((db) =>
        db
          .prepare(
            "SELECT action,before,receipt,state FROM forge_lifecycle_writes WHERE id=? AND scope=?",
          )
          .get(operation.operationId, scope(pr)),
      );
      if (!row) throw new ForgeError("not_found");
      if (row.state === "accepted" && row.receipt !== null)
        return ForgeLifecycleReceipt.parse(JSON.parse(z.string().parse(row.receipt)));
      const action = ForgeLifecycleAction.parse(JSON.parse(z.string().parse(row.action)));
      const before = ForgeLifecycleSnapshot.parse(JSON.parse(z.string().parse(row.before)));
      const observed = await backend.lifecycle.observe(
        pr.number,
        action,
        before,
        operation.operationId,
        signal,
      );
      if (!observed) throw new Error("action_outcome_uncertain");
      this.#record(operation.operationId, observed);
      return observed;
    }
    // Serialize every lifecycle write to this PR across devices and restart boundaries.
    const unresolved = this.#store.atomic((db) =>
      db
        .prepare(
          "SELECT id FROM forge_lifecycle_writes WHERE scope=? AND state IN ('uncertain','pending') LIMIT 1",
        )
        .get(scope(pr)),
    );
    if (unresolved) throw new Error("action_outcome_uncertain");
    const before = await backend.lifecycle.snapshot(pr.number, signal);
    if (before.version !== operation.expectedVersion) throw new ForgeError("conflict");
    if (!allowed() || signal.aborted) throw new ForgeError("cancelled");
    let started = false;
    try {
      const receipt = await backend.lifecycle.apply(
        pr.number,
        operation.expectedVersion,
        operation.action,
        commandId,
        signal,
        allowed,
        () => {
          this.#store.atomic((db) => {
            if (
              db
                .prepare(
                  "SELECT id FROM forge_lifecycle_writes WHERE scope=? AND state IN ('uncertain','pending') LIMIT 1",
                )
                .get(scope(pr))
            )
              throw new Error("action_outcome_uncertain");
            db.prepare("INSERT INTO forge_lifecycle_writes VALUES (?,?,?,?,'uncertain',NULL)").run(
              commandId,
              scope(pr),
              JSON.stringify(operation.action),
              JSON.stringify(before),
            );
          });
          started = true;
        },
      );
      this.#record(commandId, receipt);
      return receipt;
    } catch (error) {
      if (!started) throw error;
      if (
        error instanceof ForgeError &&
        ["forbidden", "conflict", "unsupported", "not_found"].includes(error.kind)
      ) {
        this.#store.atomic((db) =>
          db.prepare("DELETE FROM forge_lifecycle_writes WHERE id=?").run(commandId),
        );
        throw error;
      }
      if (!signal.aborted) {
        try {
          const observed = await backend.lifecycle.observe(
            pr.number,
            operation.action,
            before,
            commandId,
            signal,
          );
          if (observed) {
            this.#record(commandId, observed);
            return observed;
          }
        } catch {
          /* The durable uncertain entry is kept for explicit reconciliation. */
        }
      }
      throw new Error("action_outcome_uncertain", { cause: error });
    }
  }
}
