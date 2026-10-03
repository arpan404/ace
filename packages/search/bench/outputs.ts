import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { Event, Item, Thread } from "@ace/protocol";
import { SearchIndex } from "../src/index.ts";

// A fixed 1 MiB source tests repeated completion updates without allocating
// output-sized strings or repeating output in canonical events.
const directory = mkdtempSync(join(tmpdir(), "ace-search-output-bench-"));
const db = new DatabaseSync(join(directory, "search.sqlite"));
try {
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA cache_size=-8192; CREATE TABLE chunks(offset INTEGER PRIMARY KEY, bytes BLOB NOT NULL)",
  );
  const chunk = Buffer.from("x".repeat(4095) + " ");
  const insert = db.prepare("INSERT INTO chunks VALUES (?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 256; i++) {
    const bytes = Buffer.from(chunk);
    if (i === 0) bytes.write("headneedle ");
    if (i === 255) bytes.write(" tailneedle", 4085);
    insert.run(i * 4096, bytes);
  }
  db.exec("COMMIT");
  const read = db.prepare(
    "SELECT substr(bytes,max(0,?-offset)+1,min(length(bytes),?-offset)-max(0,?-offset)) bytes FROM chunks WHERE offset>=? AND offset<? ORDER BY offset",
  );
  let bytesRead = 0;
  const search = new SearchIndex(db, {
    readOutput: (_thread, _stream, offset, limit) => {
      const end = offset + limit;
      const bytes = Buffer.concat(
        read.all(offset, end, offset, Math.floor(offset / 4096) * 4096, end).map((row) => {
          if (!(row.bytes instanceof Uint8Array)) throw new Error("Invalid output bytes");
          return Buffer.from(row.bytes);
        }),
      );
      bytesRead += bytes.length;
      return bytes;
    },
  });
  const thread = Thread.parse({
    id: "thread",
    workspaceId: "workspace",
    title: "Outputs",
    provider: "codex",
    status: { state: "done" },
    createdAt: 1,
    updatedAt: 1,
  });
  const item = Item.parse({
    id: "shell",
    agentId: "agent",
    type: "tool_call",
    complete: true,
    createdAt: 1,
    call: {
      id: "shell",
      agentId: "agent",
      kind: "shell",
      title: "Build",
      status: "succeeded",
      startedAt: 1,
      raw: [],
      detail: {
        kind: "shell",
        command: "build",
        output: { streamId: "fixture", bytes: 1048576, tail: "tailneedle", truncated: true },
      },
    },
  });
  search.append([
    Event.parse({
      id: "thread",
      threadId: thread.id,
      seq: 1,
      at: 1,
      payload: { type: "thread.created", thread },
    }),
  ]);
  const samples: number[] = [];
  const started = performance.now();
  for (let i = 0; i < 1000; i++) {
    const before = performance.now();
    search.append([
      Event.parse({
        id: `event${i}`,
        threadId: thread.id,
        seq: i + 2,
        at: 1,
        payload: { type: i === 0 ? "item.created" : "item.updated", item },
      }),
    ]);
    samples.push(performance.now() - before);
  }
  const seconds = (performance.now() - started) / 1000;
  samples.sort((a, b) => a - b);
  process.stdout.write(
    JSON.stringify({
      sourceBytes: 1048576,
      updates: 1000,
      updatesPerSecond: 1000 / seconds,
      p50Ms: samples[500],
      p99Ms: samples[990],
      sourceBytesReadPerUpdate: bytesRead / 1000,
      indexWrites: search.status(1001).indexWrites - 1,
      headFound: search.query({ text: "headneedle" }).hits.length === 1,
      tailFound: search.query({ text: "tailneedle" }).hits.length === 1,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }) + "\n",
  );
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
