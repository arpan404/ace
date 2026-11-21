import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cwd, jsonl } from "../test-support.ts";

const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
const big = (n: number) => "x".repeat(n);

/** OpenCode's legacy storage files: sessions, messages in creation order, parts in file order. */
async function storageHome(home: string) {
  const session = (id: string, extra: Record<string, unknown>) =>
    json(join(home, "storage/session/proj", `${id}.json`), {
      id,
      directory: cwd,
      time: { created: 1767225600000, updated: 1767225900000 },
      ...extra,
    });
  const message = async (session: string, id: string, value: Record<string, unknown>) => {
    await mkdir(join(home, "storage/message", session), { recursive: true });
    await json(join(home, "storage/message", session, `${id}.json`), { id, sessionID: session, ...value });
  };
  const part = async (message: string, id: string, value: unknown, raw?: string) => {
    await mkdir(join(home, "storage/part", message), { recursive: true });
    await writeFile(join(home, "storage/part", message, `${id}.json`), raw ?? JSON.stringify(value));
  };
  await mkdir(join(home, "storage/session/proj"), { recursive: true });
  await session("ses_main", { title: "Storage session" });
  // Created later but named first: storage order is time, then name.
  await message("ses_main", "msg_a", { role: "assistant", time: { created: 1767225700000 } });
  await message("ses_main", "msg_b", { role: "user", time: { created: 1767225650000 } });
  await message("ses_main", "msg_c", { role: "assistant", time: { created: 1767225700000 } });
  await part("msg_b", "prt_2", { type: "text", text: "Port the storage reader" });
  await part("msg_b", "prt_1", { type: "text", text: "context", synthetic: true });
  await part("msg_b", "prt_3", {
    type: "file",
    mime: "image/png",
    url: "data:image/png;base64,iVBORw0KGgo=",
    time: { created: 1767225660000 },
  });
  await part("msg_a", "prt_1", { type: "reasoning", text: "Thinking about order" });
  await part("msg_a", "prt_2", {
    type: "tool",
    tool: "bash",
    state: { status: "completed", input: { command: "ls" }, output: "file.txt" },
  });
  await part("msg_a", "prt_3", null, "{not json");
  await part("msg_a", "prt_4", { type: "text", text: big(70 * 1024) });
  // More than sixteen parts sort by file name.
  for (let i = 20; i >= 0; i--)
    await part("msg_c", `prt_${String(i).padStart(2, "0")}`, { type: "text", text: `part ${i}` });
  await part("msg_c", "prt_big", { type: "text", text: big(1100 * 1024) });
  await session("ses_child", { title: "Storage child", parentID: "ses_main" });
  await message("ses_child", "msg_k", { role: "user", time: { created: 1767225800000 } });
  await part("msg_k", "prt_1", { type: "text", text: "Child task" });
  await session("ses_silent", { title: "Nothing said" });
  await message("ses_silent", "msg_s", { role: "assistant", time: { created: 1 } });
  await part("msg_s", "prt_1", { type: "text", text: "Hello?" });
  await session("ses_huge", { title: "Huge header" });
  await message("ses_huge", "msg_h", { role: "user", pad: big(200 * 1024) });
  await session("ses_untitled", {});
  await message("ses_untitled", "msg_u", { role: "user" });
  await part("msg_u", "prt_1", { type: "text", text: "Untitled request" });
}

function v1Schema(db: DatabaseSync) {
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,data TEXT);`);
}

/** OpenCode SQLite, schema v1: messages and parts as JSON rows. */
function v1Home(home: string, name: string, wal: boolean) {
  const db = new DatabaseSync(join(home, name));
  if (wal) db.exec("PRAGMA journal_mode=WAL");
  v1Schema(db);
  const session = db.prepare("INSERT INTO session VALUES(?,?,?,?,?)");
  const message = db.prepare("INSERT INTO message VALUES(?,?,?,?)");
  const part = db.prepare("INSERT INTO part VALUES(?,?,?)");
  session.run("s1", cwd, "Database session", 1767225900000, null);
  message.run("m1", "s1", 1767225600000, JSON.stringify({ role: "user", time: { created: 1767225610000 } }));
  part.run("p1", "m1", JSON.stringify({ type: "text", text: "Ship the database reader" }));
  part.run("p0", "m1", JSON.stringify({ type: "text", text: "hidden", synthetic: true }));
  message.run(
    "m2",
    "s1",
    1767225700000,
    JSON.stringify({ role: "assistant", modelID: "oc-model", time: { created: 1767225700000 } }),
  );
  part.run("p2", "m2", JSON.stringify({ type: "reasoning", text: "Plan" }));
  part.run(
    "p3",
    "m2",
    JSON.stringify({ type: "tool", tool: "read", state: { status: "error", input: { filePath: "/w/a" }, output: "denied" } }),
  );
  part.run("p4", "m2", null);
  part.run("p5", "m2", JSON.stringify({ type: "text", text: big(80 * 1024) }));
  message.run("m3", "s1", 1767225800000, "{broken");
  message.run("m4", "s1", 1767225800000, JSON.stringify({ role: "user" }));
  part.run("p6", "m4", JSON.stringify({ type: "file", mime: "image/jpeg", url: "https://example.com/a.jpg" }));
  session.run("s2", cwd, "s2", 1767225950000, "s1");
  message.run("m5", "s2", 1, JSON.stringify({ role: "user", model: { modelID: "nested-model" } }));
  part.run("p7", "m5", JSON.stringify({ type: "text", text: "Child of the database session" }));
  session.run("s3", cwd, "Only synthetic", 5, null);
  message.run("m6", "s3", 1, JSON.stringify({ role: "user" }));
  part.run("p8", "m6", JSON.stringify({ type: "text", text: "auto", synthetic: true }));
  session.run("s4", cwd, "Oversized part", 6, null);
  message.run("m7", "s4", 1, JSON.stringify({ role: "user" }));
  part.run("p9", "m7", JSON.stringify({ type: "text", text: big(1100 * 1024) }));
  session.run("s5", "/elsewhere", null, "2026-01-03T00:00:00Z", "");
  message.run("m8", "s5", 1, JSON.stringify({ role: "user" }));
  part.run("p10", "m8", JSON.stringify({ type: "text", text: "Somewhere else" }));
  db.close();
}

/** OpenCode SQLite, schema v2: one `session_message` table with a type and sequence. */
function v2Home(home: string) {
  const db = new DatabaseSync(join(home, "opencode.db"));
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT);`);
  const session = db.prepare("INSERT INTO session VALUES(?,?,?,?,?)");
  const row = db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?)");
  session.run("v1", cwd, "Version two", 1767226000000, null);
  row.run("r2", "v1", "assistant", 2, JSON.stringify({ content: [{ type: "text", text: "Answered" }] }));
  row.run("r1", "v1", "user", 1, JSON.stringify({ text: "Ask in v2", time: { created: 1767225600000 } }));
  row.run("r3", "v1", "tool", 3, JSON.stringify({ type: "tool", tool: "bash", state: { status: "running", input: { cmd: "make" } } }));
  row.run("r4", "v1", "assistant", 4, "not json");
  row.run("r5", "v1", "assistant", 5, JSON.stringify([1, 2]));
  session.run("v2", cwd, "No history at all", 7, null);
  session.run("v3", cwd, "Large v2 row", 8, null);
  row.run("r6", "v3", "user", 1, JSON.stringify({ text: big(1100 * 1024) }));
  db.close();
}

/** Pi sessions: a versioned header, names, model changes and a branching message tree. */
async function piHome(home: string) {
  const dir = join(home, "sessions/--workspace-project--");
  const header = (id: string, version: unknown) => ({
    type: "session",
    version,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
  });
  const message = (id: string, parentId: string | null, role: string, content: unknown, at = "2026-01-01T00:01:00.000Z") => ({
    type: "message",
    id,
    parentId,
    timestamp: at,
    message: { role, content },
  });
  await jsonl(join(dir, "2026-01-01_pi-main.jsonl"), [
    header("pi-main", 3),
    { type: "session_info", id: "i1", parentId: null, name: "Pi named session" },
    { type: "model_change", id: "c1", parentId: null, provider: "x", modelId: "pi-model" },
    message("a", null, "user", [{ type: "text", text: "Start the Pi work" }]),
    message("b", "a", "assistant", [
      { type: "thinking", thinking: "consider" },
      { type: "text", text: "On it" },
      { type: "toolCall", id: "call1", name: "bash", arguments: { command: "ls" } },
    ]),
    message("c", "b", "toolResult", [{ type: "text", text: "listing" }]),
    message("rewound", "b", "user", "a path not taken"),
    message("d", "c", "user", "Continue", "2026-01-02T00:00:00.000Z"),
    { type: "compaction", id: "e", parentId: "d", summary: "compacted" },
  ]);
  await jsonl(join(dir, "2026-01-01_pi-old.jsonl"), [
    header("pi-old", "2"),
    message("a", null, "user", "An older format"),
  ]);
  await jsonl(join(dir, "2026-01-01_pi-future.jsonl"), [
    header("pi-future", 9),
    message("a", null, "user", "From the future"),
  ]);
  await jsonl(join(dir, "2026-01-01_pi-headless.jsonl"), [
    message("a", null, "user", [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]),
    { type: "session", cwd },
  ]);
}

/** One home of each kind OpenCode and Pi keep their saved history in. Synthetic text. */
export async function providerHomes(root: string) {
  const storage = join(root, "opencode-storage");
  await storageHome(storage);
  const v1 = join(root, "opencode-v1");
  await mkdir(v1, { recursive: true });
  v1Home(v1, "opencode.db", false);
  // A WAL database whose writer has closed: read in place, pinned to the checked file.
  v1Home(v1, "opencode-dev.db", true);
  await writeFile(join(v1, "opencode-notes.txt"), "never opened");
  const v2 = join(root, "opencode-v2");
  await mkdir(v2, { recursive: true });
  v2Home(v2);
  const pi = join(root, "pi");
  await piHome(pi);
  return [
    { id: "opencode-storage", provider: "opencode" as const, homeDir: storage },
    { id: "opencode-v1", provider: "opencode" as const, homeDir: v1 },
    { id: "opencode-v2", provider: "opencode" as const, homeDir: v2 },
    { id: "pi-home", provider: "pi" as const, homeDir: pi },
  ];
}
