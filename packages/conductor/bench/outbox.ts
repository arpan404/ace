import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { fixture } from "../src/review-test-support.ts";

const context = fixture();
try {
  await context.driver.drain("run");
  const db = new DatabaseSync(context.path);
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO conductor_outbox(run,id,payload) VALUES (?,?,?)");
    for (let i = 0; i < 2048; i++)
      insert.run(
        "run",
        `close-${i}`,
        JSON.stringify({ type: "gate_closed", id: `close-${i}`, gateId: `gate-${i}` }),
      );
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const before = performance.now();
  let effects = 0;
  let batch = 0;
  do {
    batch = await context.driver.drain("run", 1024);
    effects += batch;
  } while (batch);
  const elapsed = performance.now() - before;
  console.log(
    JSON.stringify({
      label: "SQLite outbox drain, 2048 gate closures",
      effects,
      opsPerSecond: Math.round((effects * 1000) / elapsed),
      usPerOperation: +((elapsed * 1000) / effects).toFixed(2),
      peakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
    }),
  );
} finally {
  context.close();
}
