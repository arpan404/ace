import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import {
  busyLoopFor,
  describeCount,
  killedWhileFrozen,
  watched,
} from "./stall-watchdog-test-support.ts";

// Reading a frozen main thread's stack: the watchdog's worker pauses it through node:inspector.
// The desktop main process runs the watchdog on Electron's Node, where this works; the suite runs
// on Node (nodeOnlySuites). Bun's node:inspector has no Debugger domain, so a daemon's reports
// carry no stack; stall-watchdog.process.test.ts covers what holds on both.

test("a main thread stuck in JavaScript is reported with the function it was stuck in", async () => {
  const reports = await watched(function freezeInJavaScript() {
    busyLoopFor(1_500);
  });
  expect(reports).toHaveLength(1);
  const [report] = reports;
  expect(report).toMatchObject({ pid: process.pid, kind: "main", caught: true, ended: true });
  expect(report?.silentMs).toBeGreaterThanOrEqual(1_000);
  expect(report?.cpuMs).toBeGreaterThan(200);
  expect(report?.stack.map((frame) => frame.fn)).toContain("busyLoopFor");
  expect(report?.stack.map((frame) => frame.fn)).toContain("freezeInJavaScript");
});

test("a main thread stuck in one long SQLite statement is reported with the caller of that statement", async () => {
  const count =
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<?) SELECT count(*) FROM c";
  const db = new DatabaseSync(":memory:");
  try {
    const sample = 200_000;
    const started = performance.now();
    db.prepare(count).get(sample);
    // Rows for one native call that holds the thread about 1.5 s.
    const rows = Math.ceil((sample * 1_500) / Math.max(1, performance.now() - started));
    const reports = await watched(function freezeInSqlite() {
      const counted = db.prepare(count).get(rows);
      // Like a transaction committing: the caller carries on in JavaScript.
      return describeCount(counted);
    });
    expect(reports).toHaveLength(1);
    const [report] = reports;
    expect(report).toMatchObject({ caught: true, ended: true });
    expect(report?.stack.map((frame) => frame.fn)).toContain("freezeInSqlite");
    // The stack arrives only once the statement returns: the wait shows it sat in native code.
    expect(report?.answerMs).toBeGreaterThan(300);
  } finally {
    db.close();
  }
});

test("a main thread asleep in a wait is reported as waiting, not computing", async () => {
  const reports = await watched(function freezeInWait() {
    // Like a SQLite busy wait for another connection's lock: blocked, using no CPU.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500);
    return describeCount({ waited: 1 });
  });
  expect(reports).toHaveLength(1);
  const [report] = reports;
  expect(report).toMatchObject({ kind: "main", caught: true, ended: true });
  expect(report?.stack.map((frame) => frame.fn)).toContain("freezeInWait");
  expect(report?.cpuMs).toBeLessThan((report?.silentMs ?? 0) / 2);
});

test("a run killed while frozen leaves the stack it froze in for the next start", async () => {
  const { pid, first } = await killedWhileFrozen((recorded) => Boolean(recorded.stack?.length));
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ pid, ended: false, caught: true });
  expect(first[0]?.stack.map((frame) => frame.fn)).toContain("freezeForever");
});
