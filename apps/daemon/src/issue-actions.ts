import { z } from "zod";
import { ForgeError, repositoryKey, type GitHubForge } from "@ace/forge";
import {
  ForgeIssueAction,
  ForgeIssueWrite,
  ForgeRepository,
  type Command,
  type CommandResult,
} from "@ace/protocol";
import type { Store } from "./store.ts";
import { actionErrorCode } from "./action-errors.ts";

const saved = z.object({
  repository: ForgeRepository,
  input: ForgeIssueWrite,
  result: ForgeIssueAction,
});
/** Reservations survive disconnect/restart. Uncertain POSTs are reconciled, never replayed. */
export class IssueActions {
  readonly #store: Store;
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
        const result = saved.parse(JSON.parse(String(row.value))).result;
        return result.state === "pending"
          ? Object.assign({}, result, { state: "uncertain" as const })
          : result;
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
    if (!allowed()) throw new Error("forbidden");
    if (p.type === "forge.issue.reconcile") {
      const row = this.#store.atomic((db) =>
        db
          .prepare("SELECT device,value FROM forge_issue_actions WHERE id=? AND repo=?")
          .get(p.actionId, repositoryKey(p.repository)),
      );
      if (!row || row.device !== command.deviceId) throw new Error("forbidden");
      const action = saved.parse(JSON.parse(String(row.value)));
      if (action.result.state === "succeeded" || action.result.state === "failed")
        return {
          ok: action.result.state === "succeeded",
          issueAction: action.result,
          ...(action.result.issue ? { issue: action.result.issue } : {}),
        };
      const issue = await backend.reconcileIssue(action.input, action.result.id, signal);
      if (!allowed()) throw new Error("forbidden");
      const result: ForgeIssueAction = issue
        ? { ...action.result, state: "succeeded", issue }
        : {
            ...action.result,
            state: "uncertain",
            error:
              "The outcome could not be established. Check GitHub; this write will not be repeated.",
          };
      this.#save({ ...action, result });
      return {
        ok: Boolean(issue),
        issueAction: result,
        ...(issue ? { issue } : { error: "action_outcome_uncertain" }),
      };
    }
    const number = p.input.action === "create" ? 0 : p.input.number;
    this.#store.atomic((db) => {
      if (
        db
          .prepare(
            "SELECT 1 FROM forge_issue_actions WHERE repo=? AND number=? AND state IN ('pending','uncertain')",
          )
          .get(repositoryKey(p.repository), number)
      )
        throw new Error("issue_reconciliation_required");
      const result: ForgeIssueAction = { id: command.id, state: "pending", action: p.input.action };
      db.prepare("INSERT INTO forge_issue_actions VALUES(?,?,?,?,?,?)").run(
        command.id,
        command.deviceId,
        repositoryKey(p.repository),
        number,
        "pending",
        JSON.stringify({ repository: p.repository, input: p.input, result }),
      );
    });
    let result: ForgeIssueAction;
    try {
      const issue = await backend.writeIssue(p.input, command.id, signal);
      result = { id: command.id, state: "succeeded", action: p.input.action, issue };
    } catch (error) {
      const certain =
        error instanceof ForgeError &&
        ["forbidden", "not_found", "conflict", "rate_limit", "unsupported"].includes(error.kind);
      result = {
        id: command.id,
        state: certain ? "failed" : "uncertain",
        action: p.input.action,
        error: actionErrorCode(error),
      };
    }
    this.#save({ repository: p.repository, input: p.input, result });
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
  #save(value: z.infer<typeof saved>) {
    this.#store.atomic((db) =>
      db
        .prepare("UPDATE forge_issue_actions SET state=?,value=? WHERE id=?")
        .run(value.result.state, JSON.stringify(value), value.result.id),
    );
  }
}
