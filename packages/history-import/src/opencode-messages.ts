import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import { object, string } from "@ace/native-session";
import { hasUserInput, sanitizeUserText } from "./user-text.ts";

/** V2 stores role beside JSON data; v1 stores it inside message data. */
export function openCodeV2Columns(db: DatabaseSync): Set<string> {
  return new Set(
    db
      .prepare("PRAGMA table_info(session_message)")
      .all()
      .map((r) => String(r.name)),
  );
}
export function hasOpenCodeV2(db: DatabaseSync, session: string): boolean {
  const columns = openCodeV2Columns(db);
  return (
    columns.has("session_id") &&
    Number(
      db.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id=?").get(session)?.n ??
        0,
    ) > 0
  );
}
export function supportsOpenCodeV2(db: DatabaseSync): boolean {
  const columns = openCodeV2Columns(db);
  return ["id", "session_id", "type", "seq", "data"].every((name) => columns.has(name));
}
function firstInput(rows: Iterable<{ data?: unknown }>) {
  for (const row of rows) {
    try {
      const p = object(JSON.parse(String(row.data)));
      if (p.synthetic === true) continue;
      const text = sanitizeUserText(string(p.text) ?? "");
      if (
        text ||
        hasUserInput({
          role: "user",
          content: [
            p,
            ...(Array.isArray(p.files)
              ? p.files.map((file) => Object.assign({ type: "file" }, object(file)))
              : []),
          ],
        })
      )
        return { text, real: true };
    } catch {
      /* Unknown data stays raw at import. */
    }
  }
  return { text: "", real: false };
}
export function openCodeV2Input(db: DatabaseSync, session: string) {
  return firstInput(
    db
      .prepare(
        "SELECT data FROM session_message WHERE session_id=? AND type='user' AND octet_length(data)<=1048576 ORDER BY seq,id",
      )
      .iterate(session),
  );
}
export function openCodeV1Input(db: DatabaseSync, session: string) {
  return firstInput(
    db
      .prepare(
        "SELECT p.data FROM message m JOIN part p ON p.message_id=m.id WHERE m.session_id=? AND octet_length(m.data)<=1048576 AND json_valid(m.data) AND json_extract(m.data,'$.role')='user' AND octet_length(p.data)<=1048576 ORDER BY m.time_created,m.id,p.id",
      )
      .iterate(session),
  );
}
export function* openCodeV2Records(db: DatabaseSync, session: string, signal: AbortSignal) {
  const rows = db.prepare(
    "SELECT id,type,octet_length(data) AS bytes,CASE WHEN octet_length(data)<=1048576 THEN data ELSE NULL END AS data FROM session_message WHERE session_id=? ORDER BY seq,id",
  );
  for (const row of rows.iterate(session)) {
    signal.throwIfAborted();
    if (Number(row.bytes) > 1048576)
      throw new Error(
        "OpenCode history record is too large. Export the session from OpenCode to open it.",
      );
    const bytes = Buffer.from(String(row.data));
    const chunks = async function* () {
      yield bytes;
    };
    try {
      const record = object(JSON.parse(bytes.toString("utf8")));
      const type = String(row.type);
      yield {
        value: { ...record, id: String(row.id), type, role: type },
        bytes: bytes.length,
        chunks,
      };
    } catch {
      yield { opaque: true as const, bytes: bytes.length, chunks };
    }
  }
}
