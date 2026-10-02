import { createRedactor } from "@ace/redaction";
import { DatabaseSync } from "node:sqlite";
import { workerData, parentPort } from "node:worker_threads";
import { z } from "zod";
const redact = createRedactor({});
const { path } = z.object({ path: z.string() }).parse(workerData);
const db = new DatabaseSync(path, { readOnly: true, timeout: 200 });
// Limit each event before transferring it. Work is bounded to the newest 2000 rows.
const query = db.prepare(`SELECT seq, at,
  CASE WHEN octet_length(type) <= 128 THEN type ELSE '<OVERSIZED TYPE OMITTED>' END AS type,
  CASE WHEN octet_length(payload) <= 60000 THEN payload ELSE '"<OVERSIZED EVENT OMITTED>"' END AS payload
  FROM events WHERE seq IN (SELECT seq FROM events ORDER BY seq DESC LIMIT 2000) ORDER BY seq`);
const iterator = query.iterate();
const port = parentPort;
if (!port) throw new Error("Thread export requires a parent");
port.on("message", (input: unknown) => {
  if (input !== "next") {
    port.close();
    db.close();
    return;
  }
  const lines: string[] = [];
  let done = false;
  for (let index = 0; index < 16; index++) {
    const next = iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    const row = z
      .object({ seq: z.number(), at: z.number(), type: z.string().max(128), payload: z.string() })
      .parse(next.value);
    let payload: unknown;
    try {
      payload = JSON.parse(redact(row.payload));
    } catch {
      payload = "<INVALID PAYLOAD OMITTED>";
    }
    lines.push(JSON.stringify({ ...row, payload }) + "\n");
  }
  port.postMessage({ lines, done });
  if (done) {
    port.close();
    db.close();
  }
});
