import { Event, ThreadId } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import type { BackgroundPortsHost } from "../engine/background-ports.ts";
import { taskPorts, type PortCandidate } from "./task-ports.ts";
import { BackgroundPortWatcher } from "./watcher.ts";

describe("which ports belong to a background command", () => {
  const parents = new Map([
    [200, 100], // shell → bun
    [300, 200], // bun → vite
    [400, 1], // someone else's server
  ]);
  it("counts a listener that descends from a process holding the command's output", () => {
    const listeners = [
      { pid: 300, port: 5173, reach: "loopback" as const },
      { pid: 400, port: 8080, reach: "any" as const },
    ];
    expect(taskPorts(listeners, parents, new Set([100]))).toEqual([5173]);
  });
  it("finds nothing when no process holds the output file", () => {
    expect(taskPorts([{ pid: 300, port: 5173, reach: "any" }], parents, new Set())).toEqual([]);
  });
  it("survives a cycle in a stale process table", () => {
    const loop = new Map([
      [10, 11],
      [11, 10],
    ]);
    expect(taskPorts([{ pid: 10, port: 9000, reach: "any" }], loop, new Set([99]))).toEqual([]);
  });
});

const thread = ThreadId.parse("thread_ports");

function rig(initial: PortCandidate[]) {
  let candidates = structuredClone(initial);
  const reports: { taskId: string; ports: number[] }[] = [];
  const probed: string[][] = [];
  let answer = new Map<string, number[]>();
  const timers: (() => void)[] = [];
  let listener: ((events: readonly Event[]) => void) | undefined;
  const host: BackgroundPortsHost = {
    candidates: () => candidates,
    report(_thread, taskId, ports) {
      reports.push({ taskId, ports });
      for (const candidate of candidates)
        if (candidate.taskId === taskId) candidate.listening = ports;
    },
  };
  const watcher = new BackgroundPortWatcher({
    host,
    probe: async (paths) => {
      probed.push([...paths]);
      return answer;
    },
    subscribe(next) {
      listener = next;
      return () => (listener = undefined);
    },
    setTimer(callback) {
      timers.push(callback);
      return () => {
        const at = timers.indexOf(callback);
        if (at >= 0) timers.splice(at, 1);
      };
    },
  });
  return {
    watcher,
    reports,
    probed,
    set candidates(next: PortCandidate[]) {
      candidates = next;
    },
    answer(next: Record<string, number[]>) {
      answer = new Map(Object.entries(next));
    },
    started() {
      listener?.([
        Event.parse({
          threadId: thread,
          id: "event_1",
          seq: 1,
          at: 0,
          payload: {
            type: "background_task.started",
            task: {
              id: "task_1",
              agentId: "agent_1",
              kind: "shell",
              title: "bun run dev",
              status: "running",
              ambient: false,
              stoppable: true,
              startedAt: 0,
              raw: [],
              outputPath: "/tmp/dev.output",
            },
          },
        }),
      ]);
    },
    async fire() {
      const due = timers.splice(0);
      for (const callback of due) callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    pending: () => timers.length,
  };
}

const dev: PortCandidate = {
  taskId: "task_1",
  outputPath: "/tmp/dev.output",
  turnFinished: true,
  listening: [],
};

describe("background port watcher", () => {
  it("reports the port a command left running after a finished turn listens on, once", async () => {
    const r = rig([dev]);
    r.started();
    r.answer({ "/tmp/dev.output": [5173] });
    await r.fire();
    expect(r.reports).toEqual([{ taskId: "task_1", ports: [5173] }]);
    await r.fire();
    expect(r.reports).toHaveLength(1);
    r.watcher.close();
  });

  it("never probes a command whose agent's turn is still running", async () => {
    const r = rig([{ ...dev, turnFinished: false }]);
    r.started();
    await r.fire();
    expect(r.probed).toEqual([]);
    r.watcher.close();
  });

  it("stops watching a thread once none of its background commands run", async () => {
    const r = rig([dev]);
    r.started();
    r.candidates = [];
    await r.fire();
    expect(r.pending()).toBe(0);
    expect(r.probed).toEqual([]);
    r.watcher.close();
  });

  it("reports a server that stopped listening, so the thread waits on it again", async () => {
    const r = rig([{ ...dev, listening: [5173] }]);
    r.started();
    r.answer({ "/tmp/dev.output": [] });
    await r.fire();
    expect(r.reports).toEqual([{ taskId: "task_1", ports: [] }]);
    r.watcher.close();
  });
});
