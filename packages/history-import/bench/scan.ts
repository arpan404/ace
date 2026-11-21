// ace-history (ADR 0207) on generated homes only. The TypeScript reader it replaced was measured
// by this script before it was removed (BENCHMARKS.md).
//
//   bun packages/history-import/bench/scan.ts
//
// Per reader: 5,000 small transcripts cold and warm; the scale home (5,352 Codex and 1,027
// Claude transcripts at measured sizes, up to a sparse 1.9 GB rollout, 6,000 OpenCode legacy
// sessions, an OpenCode v2 database of 802 sessions and 48,120 rows, and a Codex state database)
// cold and warm; 2,000 Pi sessions cold and warm; a 300 MB Claude transcript of 200,000 records
// imported into the archive; and an OpenCode database session of 20,000 rows imported. Each line reports wall
// time and the reader processes' peak resident memory, sampled every 50 ms.
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { openHistory, type HistoryService } from "../src/index.ts";
import { findHistoryBinary } from "../src/rust/reader-binary.ts";
import { DatabaseSync } from "node:sqlite";
import { databaseFixture } from "./database-fixture.ts";
import { scaleFixture } from "./scale-fixture.ts";

const found = findHistoryBinary();
if (!found) throw new Error("Build native/history first (cargo build --release)");
const binary: string = found;

/** Peak resident memory of this process's children, the readers, while `run` runs. */
async function measured<T>(
  run: () => Promise<T>,
): Promise<{ value: T; ms: number; readerPeakMiB: number }> {
  let peak = 0;
  const sample = () => {
    try {
      const pids = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" })
        .trim()
        .split("\n");
      const rss = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" })
        .trim()
        .split("\n")
        .reduce((total, line) => total + Number(line.trim() || 0), 0);
      peak = Math.max(peak, rss / 1024);
    } catch {
      // No reader running at this instant.
    }
  };
  const timer = setInterval(sample, 50);
  const started = performance.now();
  try {
    const value = await run();
    sample();
    return {
      value,
      ms: Math.round(performance.now() - started),
      readerPeakMiB: Math.round(peak * 10) / 10,
    };
  } finally {
    clearInterval(timer);
  }
}

async function smallHome(root: string) {
  const project = join(root, "small/projects/p");
  await mkdir(project, { recursive: true });
  for (let batch = 0; batch < 5000; batch += 64)
    await Promise.all(
      Array.from({ length: Math.min(64, 5000 - batch) }, (_, offset) => {
        const id = `session-${batch + offset}`;
        return writeFile(
          join(project, id + ".jsonl"),
          JSON.stringify({
            type: "user",
            sessionId: id,
            cwd: "/workspace",
            message: { role: "user", content: "benchmark prompt" },
          }) + "\n",
        );
      }),
    );
  return [{ id: "small", provider: "claude" as const, homeDir: join(root, "small") }];
}

/** A real (not sparse) transcript: prompts, answers with tool calls, and their results. */
async function largeTranscript(root: string) {
  const project = join(root, "large/projects/p");
  await mkdir(project, { recursive: true });
  const stream = createWriteStream(join(project, "large.jsonl"));
  for (let i = 0; i < 200_000; i++) {
    const uuid = `u${i}`;
    const parentUuid = i ? `u${i - 1}` : null;
    const record =
      i % 4 === 0
        ? {
            type: "user",
            uuid,
            parentUuid,
            sessionId: "large",
            cwd: "/large",
            message: { role: "user", content: "q".repeat(1200) },
          }
        : i % 4 === 1
          ? {
              type: "assistant",
              uuid,
              parentUuid,
              sessionId: "large",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: "a".repeat(600) },
                  { type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "ls" } },
                ],
              },
            }
          : i % 4 === 2
            ? {
                type: "user",
                uuid,
                parentUuid,
                sessionId: "large",
                message: {
                  role: "user",
                  content: [
                    { type: "tool_result", tool_use_id: `t${i - 1}`, content: "r".repeat(2000) },
                  ],
                },
              }
            : {
                type: "assistant",
                uuid,
                parentUuid,
                sessionId: "large",
                message: {
                  role: "assistant",
                  content: [{ type: "thinking", thinking: "t".repeat(800) }],
                },
              };
    if (!stream.write(JSON.stringify(record) + "\n")) await once(stream, "drain");
  }
  stream.end();
  await once(stream, "finish");
  return [{ id: "large", provider: "claude" as const, homeDir: join(root, "large") }];
}

/** Pi sessions: a header, a name and twenty messages each. */
async function piHome(root: string) {
  const dir = join(root, "pi/sessions/--workspace--");
  await mkdir(dir, { recursive: true });
  for (let batch = 0; batch < 2000; batch += 64)
    await Promise.all(
      Array.from({ length: Math.min(64, 2000 - batch) }, (_, offset) => {
        const id = `pi-${batch + offset}`;
        const lines = [
          { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00Z", cwd: "/workspace" },
          { type: "session_info", id: "i", parentId: null, name: "Pi bench session" },
          ...Array.from({ length: 20 }, (_unused, n) => ({
            type: "message",
            id: `m${n}`,
            parentId: n ? `m${n - 1}` : null,
            timestamp: "2026-01-01T00:00:00Z",
            message: {
              role: n % 2 ? "assistant" : "user",
              content: [{ type: "text", text: "pi bench ".repeat(40) }],
            },
          })),
        ];
        return writeFile(
          join(dir, `${id}.jsonl`),
          lines.map((l) => JSON.stringify(l) + "\n").join(""),
        );
      }),
    );
  return [{ id: "pi", provider: "pi" as const, homeDir: join(root, "pi") }];
}

/** One OpenCode v1 database session of 20,000 messages, each with a text part. */
async function openCodeSession(root: string) {
  const home = join(root, "opencode-import");
  await mkdir(home, { recursive: true });
  const db = new DatabaseSync(join(home, "opencode.db"));
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,data TEXT);
    CREATE INDEX part_message ON part(message_id,id); CREATE INDEX message_session ON message(session_id,time_created,id);`);
  db.prepare("INSERT INTO session VALUES('big','/opencode','OpenCode import',1,NULL)").run();
  const message = db.prepare("INSERT INTO message VALUES(?,?,?,?)");
  const part = db.prepare("INSERT INTO part VALUES(?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 20_000; i++) {
    const role = i % 2 ? "assistant" : "user";
    message.run(`m${i}`, "big", i, JSON.stringify({ role, time: { created: i } }));
    part.run(
      `p${i}`,
      `m${i}`,
      JSON.stringify({ type: "text", text: "opencode bench ".repeat(60) }),
    );
  }
  db.exec("COMMIT");
  db.close();
  return [{ id: "opencode-import", provider: "opencode" as const, homeDir: home }];
}

async function open(
  root: string,
  mode: string,
  label: string,
  instances: Parameters<typeof openHistory>[0]["instances"],
) {
  return openHistory(
    {
      indexPath: join(root, `index-${mode}-${label}/index.sqlite`),
      instances,
      snapshot: { minFreeBytes: 0, minFreeRatio: 0 },
    },
    { readerBinary: binary },
  );
}

async function scans(
  root: string,
  mode: string,
  label: string,
  instances: Parameters<typeof openHistory>[0]["instances"],
) {
  const service = await open(root, mode, label, instances);
  try {
    for (const phase of ["cold", "warm"]) {
      const { value, ms, readerPeakMiB } = await measured(() => service.scan());
      console.log(
        JSON.stringify({
          mode,
          benchmark: `${label}-${phase}`,
          ms,
          readerPeakMiB,
          files: value.files,
          reads: value.reads,
          bytes: value.bytes,
        }),
      );
    }
  } finally {
    await service.close();
  }
}

async function largeImport(
  root: string,
  mode: string,
  instances: Parameters<typeof openHistory>[0]["instances"],
  label = "large",
  cwd = "/large",
  benchmark = "300mb-200k-record-import",
) {
  let service: HistoryService | undefined;
  try {
    service = await open(root, mode, label, instances);
    const opened = service;
    await opened.scan();
    const source = (await opened.list({ type: "history.list", cwd })).sessions[0];
    if (!source) throw new Error("Missing large session");
    const { value, ms, readerPeakMiB } = await measured(() =>
      opened.importSession({
        sourceId: source.id,
        threadId: ThreadId.parse(`bench-${mode}`),
        workspaceId: WorkspaceId.parse("bench"),
        agentId: "bench",
        at: 0,
      }),
    );
    console.log(JSON.stringify({ mode, benchmark, ms, readerPeakMiB, ...value }));
  } finally {
    await service?.close();
  }
}

const root = await mkdtemp(join(tmpdir(), "ace-history-bench-"));
try {
  const small = await smallHome(root);
  const scale = await scaleFixture(join(root, "scale"));
  databaseFixture(join(root, "scale"), "/synthetic/project");
  const pi = await piHome(root);
  const large = await largeTranscript(root);
  const opencode = await openCodeSession(root);
  for (const mode of ["rust"]) {
    await scans(root, mode, "5000-files", small);
    await scans(root, mode, "scale-home", scale.instances);
    await scans(root, mode, "pi-2000", pi);
    await largeImport(root, mode, large);
    await largeImport(root, mode, opencode, "opencode", "/opencode", "opencode-20k-message-import");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
