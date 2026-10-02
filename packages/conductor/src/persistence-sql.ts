import type { DatabaseSync } from "node:sqlite";

export function persistenceSql(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conductor_artifacts (run TEXT NOT NULL REFERENCES conductor_runs(id) ON DELETE CASCADE, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run,id));
    CREATE TABLE IF NOT EXISTS conductor_lanes (run TEXT NOT NULL REFERENCES conductor_runs(id) ON DELETE CASCADE, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run,id));
    CREATE TABLE IF NOT EXISTS conductor_nodes (run TEXT NOT NULL REFERENCES conductor_runs(id) ON DELETE CASCADE, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run,id));
    CREATE TEMP TABLE conductor_artifacts_retained (id TEXT PRIMARY KEY);`);
  return {
    artifact: db.prepare("SELECT payload FROM conductor_artifacts WHERE run=? AND id=?"),
    insertArtifact: db.prepare(
      "INSERT OR IGNORE INTO conductor_artifacts(run,id,payload) VALUES (?,?,?)",
    ),
    clearRetained: db.prepare("DELETE FROM conductor_artifacts_retained"),
    retain: db.prepare("INSERT OR IGNORE INTO conductor_artifacts_retained(id) VALUES (?)"),
    removeUnused: db.prepare(
      "DELETE FROM conductor_artifacts WHERE run=? AND id NOT IN (SELECT id FROM conductor_artifacts_retained)",
    ),
    artifactBytes: db.prepare(
      "SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS n FROM conductor_artifacts WHERE run=?",
    ),
    lanes: db.prepare("SELECT payload FROM conductor_lanes WHERE run=? ORDER BY rowid LIMIT 8193"),
    nodes: db.prepare("SELECT payload FROM conductor_nodes WHERE run=? ORDER BY rowid LIMIT 257"),
    writeLane: db.prepare(
      "INSERT INTO conductor_lanes(run,id,payload) VALUES (?,?,?) ON CONFLICT(run,id) DO UPDATE SET payload=excluded.payload",
    ),
    writeNode: db.prepare(
      "INSERT INTO conductor_nodes(run,id,payload) VALUES (?,?,?) ON CONFLICT(run,id) DO UPDATE SET payload=excluded.payload",
    ),
    deleteLane: db.prepare("DELETE FROM conductor_lanes WHERE run=? AND id=?"),
    deleteNode: db.prepare("DELETE FROM conductor_nodes WHERE run=? AND id=?"),
  };
}
export type PersistenceSql = ReturnType<typeof persistenceSql>;
