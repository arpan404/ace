import { commandNotDispatched } from "./command-not-dispatched.ts";
import { z } from "zod";
import { WriteDispatch, repositoryKey, type GitHubForge } from "@ace/forge";
import {
  ForgeIssueAction,
  ForgeIssueWrite,
  ForgeRepository,
  type Command,
  type CommandResult,
} from "@ace/protocol";
import type { Store } from "./store.ts";
import { actionErrorCode } from "./action-errors.ts";
import { ForgeWriteFlights } from "./forge-write-lifecycle.ts";

const saved = z.object({
  repository: ForgeRepository,
  input: ForgeIssueWrite,
  result: ForgeIssueAction,
  // Historical pending rows must be treated conservatively as dispatched.
  dispatched: z.boolean().default(true),
});
/** Reservations survive disconnect/restart. Uncertain POSTs are reconciled, never replayed. */
export class IssueActions {
  readonly #store: Store;
  readonly #flights = new ForgeWriteFlights();
  constructor(store: Store) {
    this.#store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS forge_issue_actions (
      id TEXT PRIMARY KEY, device TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
      state TEXT NOT NULL, value JSON NOT NULL);
      CREATE INDEX IF NOT EXISTS forge_issue_action_scope ON forge_issue_actions(repo,number,state)`),
    );
  }
  list(repository: ForgeRepository, number: number) {
    return this.#store
      .atomic((db) =>
        db
          .prepare(
            "SELECT value FROM forge_issue_actions WHERE repo=? AND number=? ORDER BY rowid DESC LIMIT 25",
          )
          .all(repositoryKey(repository), number),
      )
      .map((row) => {
        const action = saved.parse(JSON.parse(z.string().parse(row.value)));
        if (action.result.state !== "pending" || this.#flights.hasOperation(action.result.id))
          return action.result;
        return this.#save(
          {
            ...action,
            result: {
              ...action.result,
              state: action.dispatched ? "uncertain" : "failed",
              ...(!action.dispatched ? { error: "action_not_dispatched" } : {}),
            },
          },
          z.string().parse(row.value),
        );
      });
  }
  async execute(
    command: Command,
    backend: GitHubForge,
    allowed: () => boolean,
    signal: AbortSignal,
  ): Promise<Omit<CommandResult, "commandId">> {
    const p = command.payload;
    if (p.type !== "forge.issue.write" && p.type !== "forge.issue.reconcile")
      throw new Error("invalid_command");
    if (!allowed()) {
      if (p.type === "forge.issue.write") return commandNotDispatched(command, "forbidden");
      throw new Error("forbidden");
    }
    if (p.type === "forge.issue.reconcile") {
      const row = this.#store.atomic((db) =>
        db
          .prepare("SELECT device,value FROM forge_issue_actions WHERE id=? AND repo=?")
          .get(p.actionId, repositoryKey(p.repository)),
      );
      if (!row || row.device !== command.deviceId) throw new Error("forbidden");
      const action = saved.parse(JSON.parse(z.string().parse(row.value)));
      if (action.result.state === "succeeded" || action.result.state === "failed")
        return {
          ok: action.result.state === "succeeded",
          issueAction: action.result,
          ...(action.result.issue ? { issue: action.result.issue } : {}),
        };
      const scope = JSON.stringify([
        repositoryKey(p.repository),
        action.input.action === "create" ? 0 : action.input.number,
      ]);
      if (!this.#flights.acquire(scope, action.result.id))
        return { ok: false, error: "forge_write_pending", issueAction: action.result };
      try {
        if (!action.dispatched)
          return this.#receipt(
            this.#save(
              {
                ...action,
                result: { ...action.result, state: "failed", error: "action_not_dispatched" },
              },
              z.string().parse(row.value),
            ),
          );
        const issue = await backend.reconcileIssue(action.input, action.result.id, signal);
        // A read cannot downgrade a newer terminal result, even from another owner.
        const result: ForgeIssueAction = issue
          ? { ...action.result, state: "succeeded", issue }
          : { ...action.result, state: "uncertain", error: "action_outcome_uncertain" };
        return this.#receipt(this.#save({ ...action, result }, z.string().parse(row.value)));
      } finally {
        this.#flights.release(scope);
      }
    }
    const number = p.input.action === "create" ? 0 : p.input.number;
    const scope = JSON.stringify([repositoryKey(p.repository), number]);
    if (!this.#flights.acquire(scope, command.id))
      return commandNotDispatched(command, "forge_write_pending");
    try {
      // Retire a reservation that crashed before reaching mutation dispatch.
      try {
        this.list(p.repository, number);
        this.#store.atomic((db) => {
          if (
            db
              .prepare(
                "SELECT 1 FROM forge_issue_actions WHERE repo=? AND number=? AND state IN ('pending','uncertain')",
              )
              .get(repositoryKey(p.repository), number)
          )
            throw new Error("issue_reconciliation_required");
          const result: ForgeIssueAction = {
            id: command.id,
            state: "pending",
            action: p.input.action,
          };
          db.prepare("INSERT INTO forge_issue_actions VALUES(?,?,?,?,?,?)").run(
            command.id,
            command.deviceId,
            repositoryKey(p.repository),
            number,
            "pending",
            JSON.stringify({ repository: p.repository, input: p.input, result, dispatched: false }),
          );
        });
      } catch (error) {
        return commandNotDispatched(command, actionErrorCode(error));
      }
      let result: ForgeIssueAction;
      const dispatch = new WriteDispatch(() => {
        signal.throwIfAborted();
        if (!allowed()) throw new Error("forbidden");
        const reservation = this.#save({
          repository: p.repository,
          input: p.input,
          dispatched: true,
          result: { id: command.id, state: "pending", action: p.input.action },
        });
        if (reservation.state !== "pending") throw new Error("issue_reconciliation_required");
      });
      try {
        const issue = await backend.writeIssue(p.input, command.id, signal, dispatch);
        result = { id: command.id, state: "succeeded", action: p.input.action, issue };
      } catch (error) {
        result = {
          id: command.id,
          state: dispatch.definitelyFailed ? "failed" : "uncertain",
          action: p.input.action,
          error: actionErrorCode(error),
        };
      }
      return this.#receipt(
        this.#save({
          repository: p.repository,
          input: p.input,
          result,
          dispatched: !dispatch.definitelyFailed,
        }),
      );
    } finally {
      this.#flights.release(scope);
    }
  }
  #receipt(result: ForgeIssueAction): Omit<CommandResult, "commandId"> {
    return {
      ok: result.state === "succeeded",
      issueAction: result,
      ...(result.issue
        ? { issue: result.issue }
        : {
            error:
              result.state === "uncertain"
                ? "action_outcome_uncertain"
                : (result.error ?? "action_failed"),
          }),
    };
  }
  #save(value: z.infer<typeof saved>, expected?: string): ForgeIssueAction {
    return this.#store.atomic((db) => {
      db.prepare(
        "UPDATE forge_issue_actions SET state=?,value=? WHERE id=? AND state IN ('pending','uncertain') AND (? IS NULL OR value=?)",
      ).run(
        value.result.state,
        JSON.stringify(value),
        value.result.id,
        expected ?? null,
        expected ?? null,
      );
      const row = db
        .prepare("SELECT value FROM forge_issue_actions WHERE id=?")
        .get(value.result.id);
      return saved.parse(JSON.parse(z.string().parse(row?.value))).result;
    });
  }
}
