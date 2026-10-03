import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Recording } from "./recording.ts";
import { settleWatcher } from "./settle.ts";
import { findScenario } from "./scenarios.ts";

it("waits for newer work after an earlier turn ends, while heartbeats allow quiet settling", async () => {
  const root = mkdtempSync(join(tmpdir(), "ace-settle-"));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const rec = new Recording(join(root, "capture.jsonl"), {
    format: "ace-recording/v1",
    provider: "synthetic",
    cliVersion: "2",
    scenario: "background-shell",
    startedAt: "2026-10-03",
    platform: "test",
    workspace: root,
  });
  try {
    const watcher = settleWatcher(
      rec,
      { ...findScenario("background-shell"), quietMs: 500, maxMs: 5000 },
      new AbortController().signal,
    );
    let idle = false;
    let stopped = false;
    rec.mark("turn-end");
    const pending = watcher
      .settled(() => idle)
      .then(() => {
        stopped = true;
      });
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).toBe(false);
    watcher.interactions.open();
    idle = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(stopped).toBe(false);
    watcher.interactions.close();
    rec.frame("note", "transport.activity", {}, false);
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    await rec.close();
    expect(readFileSync(join(root, "capture.jsonl"), "utf8")).toContain('"reason":"settled"');
  } finally {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
});

it("records a failed transport as aborted even when no turn completed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ace-settle-abort-"));
  vi.useFakeTimers();
  const rec = new Recording(join(root, "capture.jsonl"), {
    format: "ace-recording/v1",
    provider: "synthetic",
    cliVersion: "2",
    scenario: "tool-read",
    startedAt: "2026-10-03",
    platform: "test",
    workspace: root,
  });
  try {
    const stop = new AbortController();
    const pending = settleWatcher(
      rec,
      findScenario("tool-read"),
      new AbortController().signal,
    ).settled(() => false, stop.signal);
    stop.abort();
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    await rec.close();
    expect(readFileSync(join(root, "capture.jsonl"), "utf8")).toContain('"reason":"aborted"');
  } finally {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
});
