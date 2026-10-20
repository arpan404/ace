import { z } from "zod";
import {
  OffshiftRoles,
  type OffshiftRole,
  type OffshiftRoleSelection,
} from "@ace/protocol/offshift";
import type { Transactions } from "./journal.ts";

const stored = z.object({ body: z.string() });

/** Where a role's selection came from: the run, or the project default. */
export interface ResolvedRole {
  selection: OffshiftRoleSelection;
  source: "run" | "project";
}

/** A role from the run, else the project default, else nothing (the caller's own provider). */
export function resolveRole(
  role: OffshiftRole,
  run: OffshiftRoles | undefined,
  project: OffshiftRoles | undefined,
): ResolvedRole | undefined {
  const own = run?.[role];
  if (own) return { selection: own, source: "run" };
  const fallback = project?.[role];
  return fallback ? { selection: fallback, source: "project" } : undefined;
}

/** What a delegated task states about who runs it. */
export interface RoleTask {
  provider?: OffshiftRoleSelection["provider"] | undefined;
  model?: string | undefined;
  effort?: string | undefined;
}

/**
 * Fill a delegated task from a role. A provider or model on the task is a deliberate choice,
 * so the role's provider and model are a pair the task either takes whole or not at all; an
 * effort on the task always wins.
 */
export function applyRole<T extends RoleTask>(task: T, role: ResolvedRole | undefined): T {
  if (!role) return task;
  const chosen = task.provider !== undefined || task.model !== undefined;
  const { provider, model, effort } = role.selection;
  return {
    ...task,
    ...(!chosen && provider ? { provider } : {}),
    ...(!chosen && model ? { model } : {}),
    ...(task.effort === undefined && effort && (!chosen || (!provider && !model))
      ? { effort }
      : {}),
  };
}

/**
 * The project's default roles, one row per workspace. The rows are configuration, not
 * transcript: they have no thread column, so purging a thread's payload leaves them.
 */
export class OffshiftProjectRoles {
  private readonly transactions: Transactions;
  constructor(transactions: Transactions) {
    this.transactions = transactions;
    transactions.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS offshift_project_roles (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        body TEXT NOT NULL)`),
    );
  }
  get(workspaceId: string): OffshiftRoles | undefined {
    return this.transactions.atomic((db) => {
      const row = db
        .prepare("SELECT body FROM offshift_project_roles WHERE workspace_id=?")
        .get(workspaceId);
      return row ? OffshiftRoles.parse(JSON.parse(stored.parse(row).body)) : undefined;
    });
  }
  /** Replaces the defaults; an empty set removes the row. */
  set(workspaceId: string, roles: OffshiftRoles): OffshiftRoles {
    const parsed = OffshiftRoles.parse(roles);
    this.transactions.atomic((db) => {
      if (!Object.keys(parsed).length)
        db.prepare("DELETE FROM offshift_project_roles WHERE workspace_id=?").run(workspaceId);
      else
        db.prepare(
          "INSERT INTO offshift_project_roles(workspace_id,body) VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET body=excluded.body",
        ).run(workspaceId, JSON.stringify(parsed));
    });
    return parsed;
  }
}
