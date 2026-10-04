import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openHistory } from "@ace/history-import";
import { z } from "zod";
import { writeMeasurement } from "./output.ts";

// Synthetic transcripts, never provider executables. Measure the real history service.
const count = z.coerce
  .number()
  .int()
  .min(1)
  .max(50000)
  .parse(process.argv.find((arg) => arg.startsWith("--files="))?.slice(8) ?? "5000");
const fullScans = process.argv.includes("--full-scans");
const home = await mkdtemp(join(tmpdir(), "ace-history-perf-"));
const providerHome = join(home, "claude");
const projects = join(providerHome, "projects/p");
const options = {
  indexPath: join(home, "ace/index.sqlite"),
  instances: [{ id: "perf", provider: "claude" as const, homeDir: providerHome }],
};
const cwd = "/performance/project";
function record(id: string, timestamp: string) {
  return (
    JSON.stringify({
      type: "user",
      sessionId: id,
      cwd,
      timestamp,
      message: { role: "user", content: "synthetic history" },
    }) + "\n"
  );
}
let service: Awaited<ReturnType<typeof openHistory>> | undefined;
try {
  await mkdir(projects, { recursive: true });
  for (let offset = 0; offset < count; offset += 64)
    await Promise.all(
      Array.from({ length: Math.min(64, count - offset) }, (_, index) => {
        const id = `00000000-0000-4000-8000-${String(offset + index).padStart(12, "0")}`;
        return writeFile(join(projects, `${id}.jsonl`), record(id, "2026-01-01T00:00:00Z"));
      }),
    );
  service = await openHistory(options);
  async function scan() {
    if (!service) throw new Error("History service closed");
    const start = performance.now();
    const result = fullScans ? await service.scan() : await service.scanChanges();
    return { milliseconds: performance.now() - start, result };
  }
  const cold = await scan();
  let unchanged = await scan();
  const startupInvalidations = [];
  // macOS may deliver the synthetic creation burst after the cold scan. Record
  // those verification batches separately before the unchanged live measurement.
  if (!fullScans)
    for (let attempt = 0; attempt < 8 && unchanged.result.files > 0; attempt++) {
      startupInvalidations.push(unchanged);
      unchanged = await scan();
    }
  const id = "00000000-0000-4000-8000-000000000000";
  const change = Promise.withResolvers<void>();
  const unsubscribe = fullScans ? () => {} : service.subscribeChanges(() => change.resolve());
  await appendFile(
    join(projects, `${id}.jsonl`),
    JSON.stringify({ type: "ai-title", sessionId: id, aiTitle: "changed title" }) + "\n",
  );
  if (!fullScans) await change.promise;
  unsubscribe();
  const oneChange = await scan();
  const visible = await service.list({ type: "history.list", cwd, limit: 200 });
  if (!visible.sessions.some((session) => session.title === "changed title"))
    throw new Error("Changed history was not visible");
  await service.close();
  service = await openHistory(options);
  const restart = await scan();
  await service.close();
  service = undefined;
  const db = new DatabaseSync(options.indexPath, { readOnly: true });
  let plans;
  try {
    plans = {
      changedPath: db
        .prepare("EXPLAIN QUERY PLAN SELECT native FROM sources WHERE instance=? AND path=?")
        .all("perf", join(projects, `${id}.jsonl`)),
      ancestors: db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT MAX(activity) FROM sources WHERE instance=? AND parent=?",
        )
        .all("perf", id),
      workspace: db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM sources WHERE cwd=? ORDER BY activity DESC,id DESC LIMIT 256",
        )
        .all(cwd),
    };
  } finally {
    db.close();
  }
  const result =
    JSON.stringify(
      {
        count,
        runtime: process.version,
        fullScans,
        cold,
        startupInvalidations,
        unchanged,
        oneChange,
        restart,
        plans,
      },
      null,
      2,
    ) + "\n";
  const output = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);
  await writeMeasurement(output ?? "", result);
  process.stdout.write(result);
} finally {
  await service?.close();
  await rm(home, { recursive: true, force: true });
}
