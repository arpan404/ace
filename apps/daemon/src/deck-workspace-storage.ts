import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DeckOwnership, type WorkspaceId } from "@ace/protocol";

export function migrateDeckWorkspaces(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_deck_ownership (
    workspace TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    payload TEXT NOT NULL
  )`);
}
export function saveWorkspaceDeck(
  db: DatabaseSync,
  id: WorkspaceId,
  ownership: DeckOwnership,
): void {
  db.prepare(
    "INSERT INTO workspace_deck_ownership VALUES (?,?) ON CONFLICT(workspace) DO UPDATE SET payload=excluded.payload",
  ).run(id, JSON.stringify(DeckOwnership.parse(ownership)));
}
export function readWorkspaceDeck(db: DatabaseSync, id: WorkspaceId): DeckOwnership | undefined {
  const row = db.prepare("SELECT payload FROM workspace_deck_ownership WHERE workspace=?").get(id);
  return row ? DeckOwnership.parse(JSON.parse(z.string().parse(row.payload))) : undefined;
}
