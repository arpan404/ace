import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { join } from "node:path";

/** Match provider schemas and measured record sizes without using native content. */
export function databaseFixture(root: string, cwd: string) {
  const codex = new DatabaseSync(join(root, "codex/state_5.sqlite"));
  codex.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,title TEXT,updated_at INTEGER)");
  const thread = codex.prepare("INSERT INTO threads VALUES(?,?,?,?)");
  codex.exec("BEGIN");
  for (let i = 0; i < 5351; i++)
    thread.run(
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      cwd,
      i % 100 === 0
        ? "A previous agent produced the plan below.\n" + "synthetic plan ".repeat(9000)
        : "Find app version",
      1,
    );
  codex.exec("COMMIT");
  codex.close();
  const db = new DatabaseSync(join(root, "opencode/opencode.db"));
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT);
    CREATE INDEX message_session ON session_message(session_id,seq,id);`);
  const session = db.prepare("INSERT INTO session VALUES(?,?,?,?,NULL)");
  const message = db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 802; i++) {
    session.run(`db-${i}`, cwd, "Title request: Find app version", 1);
    for (let j = 0; j < 60; j++)
      message.run(
        `${i}-${j}`,
        `db-${i}`,
        j === 0 ? "user" : "assistant",
        j,
        JSON.stringify(
          j === 0
            ? { text: "Find app version", files: [] }
            : { text: "Synthetic assistant output. ".repeat(300) },
        ),
      );
  }
  // The measured largest v2 record is 27,350,606 bytes. No in-memory transcript array.
  db.prepare(
    "UPDATE session_message SET data=CAST(zeroblob(27350606) AS TEXT) WHERE id='0-59'",
  ).run();
  db.exec("COMMIT");
  db.close();
}
