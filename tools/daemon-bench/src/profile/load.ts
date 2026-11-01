import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { ThreadId, type WorkspaceId } from "@ace/protocol";
import type { Driver } from "../driver.ts";

export interface LoadOptions {
  /** Starts turns; the other clients observe. */
  driver: Driver;
  observers: readonly Driver[];
  workspace: WorkspaceId;
  /** A long thread the pager pages and searches. */
  history: ThreadId;
  lanes: number;
  /** Turns per lane; the load also stops at `untilMs` (performance.now()) when given. */
  cycles: number;
  untilMs?: number;
  /** Pause between a lane's turns, like a person reading before the next prompt. */
  thinkMs?: number;
  deltas: number;
  /** Each lane keeps one thread and sends every turn into it (no per-session setup). */
  sameThread?: boolean;
}

/** Fake-CLI scenarios a lane rotates through: subagents, MCP calls, long text, tool reads. */
export function scripts(deltas: number) {
  return [
    "fixture=subagent",
    "fixture=native-ace-mcp",
    `long answer text-deltas=${deltas}`,
    "fixture=tool-read",
  ];
}

/**
 * Concurrent lanes of new threads, each watched by every observer like other windows and
 * devices, while the first observer pages and searches the long thread. Resolves with the
 * number of finished turns and paging rounds.
 */
export async function runLoad(options: LoadOptions) {
  const { driver, observers, workspace, history, lanes, cycles, untilMs, thinkMs = 0 } = options;
  const rotation = scripts(options.deltas);
  const state = { lanesDone: false };
  let turns = 0;
  const more = (cycle: number) =>
    cycle < cycles && (untilMs === undefined || performance.now() < untilMs);
  const lane = async (laneIndex: number) => {
    if (options.sameThread) {
      const id = ThreadId.parse(`busy-${laneIndex}-${randomUUID()}`);
      const leases = observers.map((client) => client.client.thread(id));
      try {
        await driver.createTurn(
          workspace,
          "claude",
          rotation[laneIndex % rotation.length] ?? "",
          id,
        );
        turns++;
        const watched = driver.watch(id);
        try {
          for (let cycle = 1; more(cycle); cycle++) {
            await watched.send(`${rotation[(laneIndex + cycle) % rotation.length] ?? ""} ${cycle}`);
            turns++;
            if (thinkMs) await pause(thinkMs);
          }
        } finally {
          watched.release();
        }
      } finally {
        for (const lease of leases) lease.release();
      }
      return;
    }
    for (let cycle = 0; more(cycle); cycle++) {
      const id = ThreadId.parse(`busy-${laneIndex}-${cycle}-${randomUUID()}`);
      const leases = observers.map((client) => client.client.thread(id));
      try {
        const text = rotation[(laneIndex + cycle) % rotation.length] ?? "";
        await driver.createTurn(workspace, "claude", text, id);
        turns++;
      } finally {
        for (const lease of leases) lease.release();
      }
      if (thinkMs) await pause(thinkMs);
    }
  };
  const pager = async (client: Driver) => {
    let rounds = 0;
    while (!state.lanesDone) {
      const lease = client.client.thread(history);
      try {
        await pause(300);
        for (let page = 0; page < 20; page++) await client.client.loadOlder(history, 50);
        await client.client.threadSearch({ threadId: history, text: "README", scope: "tree" });
        await client.client.threadsWindow({ project: workspace });
        rounds++;
      } finally {
        lease.release();
      }
      await pause(500);
    }
    return rounds;
  };
  const [pages] = await Promise.all([
    pager(observers[0] ?? driver),
    Promise.all(Array.from({ length: lanes }, (_, index) => lane(index))).finally(() => {
      state.lanesDone = true;
    }),
  ]);
  return { turns, pages };
}

/** A long thread built through ordinary turns, for paging and search. */
export async function buildHistory(driver: Driver, workspace: WorkspaceId, turns: number) {
  const history = await driver.createTurn(workspace, "claude", "fixture=native-ace-mcp");
  const watched = driver.watch(history);
  for (let turn = 0; turn < turns; turn++)
    await watched.send(turn % 3 === 0 ? "fixture=subagent" : `fixture=native-ace-mcp ${turn}`);
  watched.release();
  return history;
}
