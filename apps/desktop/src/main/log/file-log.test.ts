import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopLog } from "./desktop-log.ts";
import { createFileLog, type FileLogOptions } from "./file-log.ts";

const roots: string[] = [];
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "ace-desktop-log-"));
  roots.push(root);
  return join(root, "logs");
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

/** Flushes only when the test asks, so nothing depends on wall-clock timers. */
function fileLog(options: Partial<FileLogOptions> & { directory: string }) {
  return createFileLog({
    name: "desktop",
    maxBytes: 1024,
    rotations: 3,
    schedule: () => {},
    ...options,
  });
}
const redact = createDiagnosticRedactor({ home: "/Users/someone", env: {} });
const record = (index: number) => JSON.stringify({ index, pad: "x".repeat(80) });
const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean);

describe("desktop log file", () => {
  it("persists structured records from the main process and the daemon's output", async () => {
    const dir = directory();
    const file = fileLog({ directory: dir, maxBytes: 1024 * 1024 });
    const logger = createDesktopLog({ file, now: () => 1_000, console: () => {}, redact });
    logger("supervisor")("error", "The daemon stopped answering health checks; stopping it", {
      missed: 3,
    });
    logger("daemon")("warn", "Fatal error: unable to open database file", { stream: "stderr" });
    await file.flush();
    expect(lines(join(dir, "desktop.jsonl")).map((line) => JSON.parse(line))).toEqual([
      {
        at: 1_000,
        level: "error",
        component: "supervisor",
        message: "The daemon stopped answering health checks; stopping it",
        data: { missed: 3 },
      },
      {
        at: 1_000,
        level: "warn",
        component: "daemon",
        message: "Fatal error: unable to open database file",
        data: { stream: "stderr" },
      },
    ]);
  });

  it("redacts secrets in records and daemon output before they reach the file or console", async () => {
    const dir = directory();
    const file = fileLog({ directory: dir, maxBytes: 1024 * 1024 });
    const printed: string[] = [];
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const logger = createDesktopLog({
      file,
      now: () => 0,
      console: (_level, text) => printed.push(text),
      redact: createDiagnosticRedactor({
        home: "/Users/someone",
        env: { ACE_PAIRING_TOKEN: "pairing-value-0123456789" },
      }),
    });
    logger("supervisor")("info", "Pairing with pairing-value-0123456789", {
      token: secret,
      folder: "/Users/someone/project",
    });
    logger("daemon")("warn", `Error: OPENAI_API_KEY=${apiKey} rejected`, { stream: "stderr" });
    // Long data is clipped after redaction, so a cut cannot leave the start of a secret.
    logger("daemon")("info", "Spawned", { pad: "x".repeat(9_000), token: secret });
    await file.flush();
    const written = readFileSync(join(dir, "desktop.jsonl"), "utf8");
    for (const text of [written, printed.join("\n")]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(apiKey);
      expect(text).not.toContain("pairing-value-0123456789");
      expect(text).not.toContain("/Users/someone");
    }
    const [first, second] = lines(join(dir, "desktop.jsonl")).map(
      (line) => JSON.parse(line) as { message: string; data: Record<string, unknown> },
    );
    expect(first?.data).toEqual({ token: "<SECRET>", folder: "<HOME>/project" });
    expect(second?.message).toBe("Error: OPENAI_API_KEY=<SECRET> rejected");
  });

  it("rotates at the size cap and keeps only the newest files", async () => {
    const dir = directory();
    const file = fileLog({ directory: dir, maxBytes: 1024, rotations: 3 });
    for (let index = 0; index < 100; index++) {
      file.append(record(index));
      if (index % 10 === 9) await file.flush();
    }
    await file.flush();
    expect(readdirSync(dir).toSorted()).toEqual([
      "desktop.1.jsonl",
      "desktop.2.jsonl",
      "desktop.3.jsonl",
      "desktop.jsonl",
    ]);
    for (const name of readdirSync(dir))
      expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(1024);
    const kept = ["desktop.3.jsonl", "desktop.2.jsonl", "desktop.1.jsonl", "desktop.jsonl"]
      .flatMap((name) => lines(join(dir, name)))
      .map((line) => (JSON.parse(line) as { index: number }).index);
    // Oldest first and contiguous up to the last record: rotation drops only the oldest.
    expect(kept.at(-1)).toBe(99);
    expect(kept).toEqual(kept.map((_, offset) => 99 - (kept.length - 1) + offset));
    expect(kept.length).toBeLessThan(100);
  });

  it("writes what is still queued when the app exits", () => {
    const dir = directory();
    const file = fileLog({ directory: dir });
    file.append('{"message":"Quitting"}');
    file.flushSync();
    expect(lines(join(dir, "desktop.jsonl"))).toEqual(['{"message":"Quitting"}']);
  });

  it("counts records it cannot write instead of throwing into the app", async () => {
    const dir = directory();
    const parent = join(dir, "..");
    chmodSync(parent, 0o500); // the logs folder cannot be created
    const file = fileLog({ directory: dir });
    const logger = createDesktopLog({ file, now: () => 0, console: () => {}, redact });
    expect(() => logger("desktop")("info", "Started")).not.toThrow();
    await file.flush();
    expect(() => file.flushSync()).not.toThrow();
    expect(file.stats().failed).toBe(1);
  });

  it("bounds what waits in memory", () => {
    const file = fileLog({ directory: directory(), maxQueuedBytes: 100 });
    for (let index = 0; index < 10; index++) file.append("x".repeat(30));
    expect(file.stats()).toMatchObject({ queued: 3, dropped: 7 });
  });
});
