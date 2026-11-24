// SPDX-License-Identifier: Apache-2.0

/**
 * The two-process store cross gate (porting guide task 5.x-gate, ADR 0223 §8): one home written by
 * six child processes, each a fresh process so `ACE_STORE` and `ACE_STORE_WRITER` take the backend
 * the boot log gives that boot. It is the `*.process.test.ts` rule 2 allows: a home crossing
 * backends between processes, whose real edge is process death. Under `scripts/native-cross.ts`
 * the same file passes twice, starting on and starting off.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalWriterParts } from "@ace/provider-kit/native-switches";
import { afterEach, expect, test } from "vitest";
import {
  alongsideAppends,
  burstOneAppends,
  burstScript,
  burstTexts,
  Report,
  requiredWrites,
  thresholdAppend,
  thresholdBurstCount,
  type Phase,
} from "./store-cross-child.ts";
import { capabilities } from "./thread-column-samples.ts";
import type { Disk } from "./store-cross-test-support.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

/** The six boots, in order: a clean write, each crash kind in each mode, then the final read. */
const phases: readonly Phase[] = [
  "write",
  "crash-in-transaction",
  "crash-in-transaction",
  "crash-with-buffered-tail",
  "crash-with-buffered-tail",
  "final",
];

type Run = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

/** Runs one boot in its own process, with the evidence file beside the reports. */
function runBoot(
  boot: number,
  phase: Phase,
  home: string,
  previous: string | undefined,
  report: string,
  evidence: string,
): Promise<Run> {
  const script = fileURLToPath(new URL("./store-cross-child.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [script, String(boot), phase, home, previous ?? "-", report],
      {
        env: { ...process.env, ACE_STORE_WRITER_EVIDENCE: evidence },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.resume();
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

function value<T>(values: readonly T[], index: number): T {
  const found = values[index];
  if (found === undefined) throw new Error(`Missing value ${index}`);
  return found;
}

function find<T>(values: readonly T[], match: (entry: T) => boolean, label: string): T {
  const found = values.find(match);
  if (found === undefined) throw new Error(`Missing ${label}`);
  return found;
}

/** A stored JSON column, parsed for the values the test compares. */
function parsed(column: unknown): Record<string, unknown> {
  return JSON.parse(String(column)) as Record<string, unknown>;
}

/** A disk read without its WAL size, which differs by when the reader ran. */
function withoutWal(disk: Disk): Omit<Disk, "walBytes"> {
  const { walBytes: _walBytes, ...rest } = disk;
  return rest;
}

/** An empty home, for boot 0's comparison against what it wrote. */
const empty: Disk = {
  events: [],
  hostSequence: 0,
  recent: [],
  threads: [],
  cold: [],
  revisions: [],
  stamps: [],
  walBytes: 0,
};

const kindsOf = (
  payload: string,
): { type: string; itemId: string; field: string; append: string } => {
  const parsedPayload = JSON.parse(payload) as Record<string, unknown>;
  return {
    type: String(parsedPayload["type"]),
    itemId: String(parsedPayload["itemId"] ?? ""),
    field: String(parsedPayload["field"] ?? ""),
    append: String(parsedPayload["append"] ?? ""),
  };
};

test("a home written in one process reopens in another with every read, sequence and live delta intact, after clean closes, a kill inside a transaction and a kill with a buffered tail", async () => {
  const root = mkdtempSync(join(tmpdir(), "ace-store-cross-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home);
  const evidence = join(root, "evidence.log");

  // Each boot's mode is this run's start and the gate's alternation, both canonical, so a
  // reordered, padded or repeated part list in the environment can't fail the check.
  const cross = process.env.ACE_NATIVE_CROSS;
  const start = canonicalWriterParts(process.env.ACE_STORE_WRITER);
  const other =
    start === "" ? canonicalWriterParts(process.env.ACE_STORE_WRITER_CROSS ?? "fold") : "";
  const partsOf = (n: number) => (cross === "ACE_STORE_WRITER" && n % 2 === 1 ? other : start);
  const native = process.env.ACE_STORE === "native";
  const backendOf = (n: number) =>
    (cross === "ACE_STORE" && n % 2 === 1 ? !native : native) ? "native" : "typescript";

  /** The kinds the evidence file recorded for a pid. */
  const evidenceOf = (pid: number): string[] =>
    (existsSync(evidence) ? readFileSync(evidence, "utf8") : "")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.split(" "))
      .filter(([recorded]) => recorded === String(pid))
      .map(([, kind]) => String(kind));

  const boots: Report[] = [];
  const pids = new Set<number>();
  for (const [boot, phase] of phases.entries()) {
    const reportPath = join(root, `report-${boot}.json`);
    const previous = boot === 0 ? undefined : join(root, `report-${boot - 1}.json`);
    const run = await runBoot(boot, phase, home, previous, reportPath, evidence);
    // 1. The exit the phase asks for: a crash dies by SIGKILL, which Windows reports as exit 1.
    const crashed = phase === "crash-in-transaction" || phase === "crash-with-buffered-tail";
    if (crashed && process.platform !== "win32")
      expect(run.signal, `boot ${boot}: ${run.stderr}`).toBe("SIGKILL");
    else expect(run.code, `boot ${boot}: ${run.stderr}`).toBe(crashed ? 1 : 0);
    const report = Report.parse(JSON.parse(readFileSync(reportPath, "utf8")) as unknown);
    expect(report.boot).toBe(boot);
    expect(report.phase).toBe(phase);
    if (crashed)
      expect(report.crashing).toBe(phase === "crash-in-transaction" ? "transaction" : "tail");
    else expect(report.crashing).toBeUndefined();

    // The mode is the one this boot had to take, and its evidence is exactly its parts.
    expect(report.parts).toBe(partsOf(boot));
    expect(report.backend).toBe(backendOf(boot));
    const expectedKinds = report.parts === "" ? [] : report.parts.split(",");
    expect(evidenceOf(report.pid).toSorted()).toEqual(expectedKinds.toSorted());

    expect(report.pid).not.toBe(process.pid);
    expect(pids.has(report.pid)).toBe(false);
    pids.add(report.pid);
    boots.push(report);
  }

  const text = burstTexts();
  for (let n = 1; n < boots.length; n++) {
    const report = value(boots, n);
    const prev = value(boots, n - 1);
    const preOpen = report.preOpen;
    const opened = report.opened;
    const closed = report.closed;
    if (preOpen === undefined || opened === undefined || closed === undefined)
      throw new Error(`Boot ${n} did not read both ends`);

    // 2. The disk is what the previous mode left, WAL size aside.
    expect(withoutWal(preOpen), `boot ${n} found a different disk`).toStrictEqual(
      withoutWal(prev.durable),
    );
    if (prev.crashing === "tail") {
      const killDisk = prev.killDisk;
      if (killDisk === undefined) throw new Error("Missing the killed disk");
      expect(withoutWal(preOpen)).toStrictEqual(withoutWal(killDisk));
    }

    // 3. Reads survive the crossing: threads, windows and revisions, the cache, head and texts.
    expect(opened).toStrictEqual(prev.closed);

    // 4. The killed transaction left nothing behind, and its frames were on disk when it died.
    if (prev.crashing === "transaction") {
      expect(preOpen.threads.some((row) => row["id"] === `crash-${n - 1}`)).toBe(false);
      expect(preOpen.recent.some((row) => row.opened_at === 6e12 + (n - 1))).toBe(false);
      expect(prev.walInside).toBeGreaterThan(0);
      expect(prev.walBefore).toBe(0);
    }

    // 5. Sequences continue past what was reserved, not just past what was published. Every row
    // the boot stored is a row `preOpen` did not hold, so a reused sequence cannot fall out of
    // the comparison by being filtered against the very watermark it had to clear.
    const seqs = preOpen.events.map((event) => event.seq);
    expect(seqs).toStrictEqual([...seqs].toSorted((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const held = new Set(seqs);
    const storedNow = report.durable.events.filter((event) => !held.has(event.seq));
    expect(storedNow.length, `boot ${n} stored no row of its own`).toBeGreaterThanOrEqual(6);
    for (const event of storedNow)
      expect(event.seq, `boot ${n} reused a sequence`).toBeGreaterThan(preOpen.hostSequence);
    expect(report.published.length).toBeGreaterThan(0);
    for (const seq of report.published)
      expect(seq, `boot ${n} reused a sequence`).toBeGreaterThan(preOpen.hostSequence);
    for (const seq of report.requiredSeqs)
      expect(
        report.requiredDisk.events.some((event) => event.seq === seq),
        `boot ${n} lost a required write's row`,
      ).toBe(true);
    if (prev.crashing === "tail") expect(report.probeFirst).toBe("snapshot");
    expect(opened.texts["answer-1"]).toBe(alongsideAppends.join("").repeat(n));

    // 8. Revisions move forward, and the phase's threads are behind them.
    expect(closed.revisions).toHaveLength(opened.revisions.length);
    closed.revisions.forEach((revision, index) =>
      expect(revision).toBeGreaterThanOrEqual(value(opened.revisions, index)),
    );
    expect(value(closed.revisions, 0)).toBeGreaterThan(value(opened.revisions, 0));
    expect(value(closed.revisions, 1)).toBeGreaterThan(value(opened.revisions, 1));
  }

  for (const [b, report] of boots.entries()) {
    // 6. No lost or duplicated deltas. The expected text comes from the input scripts, and the
    // state after boot `b` is the next boot's copy or, after the last boot, its own durable image.
    const after = boots[b + 1]?.preOpen ?? report.durable;
    const read = boots[b + 1]?.opened ?? report.closed;
    if (read === undefined) throw new Error(`Boot ${b} did not observe its end`);
    for (let k = 1; k <= 4; k++) {
      const item = `live-${b}-${k}`;
      expect(read.texts[item], `burst ${k} of boot ${b} reads back`).toBe(text[String(k)]);
      const stored = after.events
        .filter((row) => row.type === "item.delta")
        .map((row) => kindsOf(row.payload))
        .filter((payload) => payload.itemId === item);
      for (const field of new Set(burstScript(k).map((row) => row.field)))
        expect(
          stored
            .filter((row) => row.field === field)
            .map((row) => row.append)
            .join(""),
          `burst ${k}'s ${field} text of boot ${b}`,
        ).toBe(
          burstScript(k)
            .filter((row) => row.field === field)
            .map((row) => row.append)
            .join(""),
        );
    }
    const next = boots[b + 1];
    if (report.crashing === "tail" && next !== undefined) {
      // Created and committed empty before the kill, so no row of it ever reached SQLite.
      expect(next.opened?.texts[`tail-${b}`]).toBe("");
      expect(
        (next.preOpen?.events ?? []).some(
          (row) => row.type === "item.delta" && kindsOf(row.payload).itemId === `tail-${b}`,
        ),
      ).toBe(false);
    }

    // 7. The required writes landed with their columns, revisions and stamps.
    const disk = report.requiredDisk;
    const before = report.preOpen ?? empty;
    const ids = report.state.ids;
    expect(
      find(disk.recent, (row) => row.workspace_id === value(report.state.workspaces, b % 3), "row")
        .opened_at,
    ).toBe(4e12 + b);
    // An imported thread started nothing now: its workspace's recency is untouched. Boot 0 has
    // no earlier disk to compare with, so it checks the row is not the imported `at`.
    const importedWorkspace = value(report.state.workspaces, (b + 1) % 3);
    const importedRow = disk.recent.find((row) => row.workspace_id === importedWorkspace);
    expect(importedRow?.opened_at).not.toBe(5e12 + b);
    if (report.preOpen !== undefined)
      expect(importedRow).toStrictEqual(
        before.recent.find((row) => row.workspace_id === importedWorkspace),
      );
    const queueRow = find(disk.threads, (row) => row["id"] === value(ids, 0), "thread 0");
    expect(parsed(queueRow["provider_metadata"])["queue"]).toMatchObject(requiredWrites.queue);
    const clientRow = find(disk.threads, (row) => row["id"] === value(ids, 1), "thread 1");
    expect(parsed(clientRow["client"])).toMatchObject({
      pinned: requiredWrites.client.pinned,
      live: requiredWrites.client.live,
    });
    expect(
      parsed(
        find(disk.cold, (row) => row["thread_id"] === value(ids, 1), "thread 1 cold")["details"],
      ),
    ).toMatchObject(requiredWrites.client.details);
    const hotRow = find(disk.threads, (row) => row["id"] === value(ids, 2), "thread 2");
    expect(hotRow["title"]).toBe(requiredWrites.thread.title);
    expect(parsed(hotRow["status"])).toMatchObject(requiredWrites.thread.status);
    expect(
      parsed(
        find(disk.cold, (row) => row["thread_id"] === value(ids, 2), "thread 2 cold")[
          "capabilities"
        ],
      ),
    ).toStrictEqual(JSON.parse(JSON.stringify(capabilities(2))) as unknown);
    for (const id of [value(ids, 0), value(ids, 1), value(ids, 2)]) {
      const revision = find(
        disk.revisions,
        (row) => row.thread_id === id,
        `revision ${id}`,
      ).revision;
      const previous = before.revisions.find((row) => row.thread_id === id)?.revision;
      if (previous !== undefined) expect(revision).toBeGreaterThan(previous);
      expect(find(disk.stamps, (row) => row["thread_id"] === id, `stamp ${id}`)["revision"]).toBe(
        revision,
      );
    }
    // This boot's six required writes, in that order. Their rows are named by sequence: a write
    // may also append its own live-metadata follow-up beside them.
    expect(report.requiredSeqs).toHaveLength(6);
    expect(
      disk.events
        .filter((event) => report.requiredSeqs.includes(event.seq))
        .map((event) => event.type),
    ).toStrictEqual([
      "thread.created",
      "thread.created",
      "agent.created",
      "queue.updated",
      "thread.client.updated",
      "thread.updated",
    ]);
  }

  // The row boundaries are the same in every boot whichever mode wrote them, and the threshold
  // burst is its inputs one to one, with one merged burst-1 row holding more than one input.
  const first = value(boots, 0);
  for (const report of boots) {
    for (let k = 1; k <= 4; k++)
      expect(
        (report.rows[String(k)] ?? []).map(({ field, append }) => ({ field, append })),
        `burst ${k}'s rows in boot ${report.boot}`,
      ).toStrictEqual(
        (first.rows[String(k)] ?? []).map(({ field, append }) => ({ field, append })),
      );
    expect((report.rows["1"] ?? []).length).toBeLessThan(burstOneAppends.length);
    expect((report.rows["3"] ?? []).map(({ field, append }) => ({ field, append }))).toStrictEqual(
      Array.from({ length: thresholdBurstCount }, (_, i) => ({
        field: "text",
        append: thresholdAppend(i + 1),
      })),
    );
  }
});
