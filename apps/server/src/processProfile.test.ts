import { describe, expect, it } from "vitest";

import {
  buildProcessTree,
  deriveCpuPercentsFromCpuSeconds,
  type ProcessProfileSample,
} from "./processProfile";

describe("processProfile", () => {
  it("builds a process tree rooted at a target pid", () => {
    const samples: ReadonlyArray<ProcessProfileSample> = [
      {
        pid: 100,
        ppid: 1,
        rssBytes: 200 * 1024 * 1024,
        cpuPercent: 20.5,
        cpuSecondsTotal: null,
        executable: "node",
        command: "node ace serve",
      },
      {
        pid: 101,
        ppid: 100,
        rssBytes: 70 * 1024 * 1024,
        cpuPercent: 8.1,
        cpuSecondsTotal: null,
        executable: "zsh",
        command: "zsh -lc codex",
      },
      {
        pid: 102,
        ppid: 101,
        rssBytes: 30 * 1024 * 1024,
        cpuPercent: 3.9,
        cpuSecondsTotal: null,
        executable: "codex",
        command: "codex app-server",
      },
      {
        pid: 999,
        ppid: 1,
        rssBytes: 10 * 1024 * 1024,
        cpuPercent: 1,
        cpuSecondsTotal: null,
        executable: "unrelated",
        command: "sleep 999",
      },
    ];

    const snapshot = buildProcessTree(samples, 100);
    expect(snapshot.found).toBe(true);
    expect(snapshot.processes.map((sample) => sample.pid)).toEqual([100, 101, 102]);
    expect(snapshot.totalRssBytes).toBe(300 * 1024 * 1024);
    expect(snapshot.totalCpuPercent).toBe(32.5);
  });

  it("marks tree as missing when root pid is absent", () => {
    const snapshot = buildProcessTree([], 42);
    expect(snapshot.found).toBe(false);
    expect(snapshot.processes).toEqual([]);
    expect(snapshot.totalRssBytes).toBe(0);
    expect(snapshot.totalCpuPercent).toBeNull();
  });

  it("derives cpu percent from cumulative cpu seconds", () => {
    const samples: ReadonlyArray<ProcessProfileSample> = [
      {
        pid: 101,
        ppid: 100,
        rssBytes: 70 * 1024 * 1024,
        cpuPercent: null,
        cpuSecondsTotal: 12,
        executable: "child",
        command: "child command",
      },
    ];

    const result = deriveCpuPercentsFromCpuSeconds({
      samples,
      previousCpuSecondsByPid: new Map([[101, 10]]),
      elapsedMs: 1_000,
      cpuCoreCount: 4,
    });

    expect(result.samples[0]?.cpuPercent).toBe(50);
    expect(result.nextCpuSecondsByPid.get(101)).toBe(12);
  });
});
