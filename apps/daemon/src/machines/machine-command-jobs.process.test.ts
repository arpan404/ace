import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { Command } from "@ace/protocol";
import { invoke } from "../browser-mcp-test-support.ts";
import { commandContext } from "../commands.ts";
import { pairedMachines } from "./machine-test-support.ts";
import { fleetWindow, sourceProfile } from "./grants-test-support.ts";

/*
 * Background command jobs an agent starts on another machine hold its thread here: it never
 * reads done while the job runs there, and never stays held once the job can't be running.
 */

type Pair = Awaited<ReturnType<typeof pairedMachines>>;
const ToolResult = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    isError: z.boolean().optional(),
  }),
});

async function commandsAllowed() {
  const pair = await pairedMachines({ access: "operate" });
  const window = await fleetWindow(pair.target);
  await window.set(sourceProfile(pair).deviceId, "commands", "operate");
  await window.close();
  return pair;
}
/** The calling agent starts a background command on the Mac, as its provider would over MCP. */
async function startJob(pair: Pair, command: string) {
  const { threadId, agentId } = pair.source.caller;
  const lease = pair.source.daemon.mcp.openSession(
    { sessionId: `jobs-${randomUUID()}`, threadId, agentId, capabilities: ["agents"] },
    new AbortController().signal,
  );
  const connection = { url: pair.source.daemon.mcp.url, bearer: lease.bearer };
  const { result } = ToolResult.parse(
    await (
      await invoke(connection, "command_run", {
        machine: "studio",
        project: "project",
        command,
        background: true,
      })
    ).json(),
  );
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.content[0]?.text).toContain("Started job-");
}
/** The calling agent's own turn ends, as its provider reports it. */
async function endTurn(pair: Pair) {
  const { source } = pair;
  const context = source.h.contexts.get(source.caller.threadId);
  if (!context) throw new Error("Calling session not open");
  context.onFrame(
    source.h.frames.frame(
      {
        type: "item.upsert",
        agent: "root",
        item: randomUUID(),
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: "Started the server there." }],
          complete: true,
        },
      },
      { type: "turn.ended", agent: "root", outcome: "completed" },
    ),
  );
  await source.daemon.engine?.flush();
}
const state = (pair: Pair) =>
  pair.source.daemon.store.getThread(pair.source.caller.threadId)?.status;
const rows = (pair: Pair) =>
  Object.values(
    pair.source.daemon.store.snapshotThread(pair.source.caller.threadId).backgroundTasks,
  );
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function pidFrom(path: string): Promise<number> {
  await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 15_000 });
  return Number(readFileSync(path, "utf8").trim());
}

it("the calling thread waits while its job on another machine runs, and is done once it ends", async () => {
  const pair = await commandsAllowed();
  await startJob(pair, "sleep 2; echo built");
  await endTurn(pair);
  // Its own agent finished, but the job there still runs: never done.
  expect(state(pair)).toMatchObject({ state: "waiting", on: "background_task" });
  expect(rows(pair)).toEqual([
    expect.objectContaining({ status: "running", title: "sleep 2; echo built on studio" }),
  ]);
  await vi.waitFor(() => expect(state(pair)?.state).toBe("done"), { timeout: 20_000 });
  expect(rows(pair).map((row) => row.status)).toEqual(["completed"]);
}, 40_000);

it("the person's Stop on the row here stops the job on its machine, with every process it started", async () => {
  const pair = await commandsAllowed();
  const project = pair.target.h.home;
  await startJob(pair, "sleep 60 & echo $! > held.pid; wait");
  const sleeper = await pidFrom(join(project, "held.pid"));
  await endTurn(pair);
  expect(state(pair)?.state).toBe("waiting");
  const [row] = rows(pair);
  if (!row) throw new Error("No row");
  const engine = pair.source.daemon.engine;
  if (!engine) throw new Error("No engine");
  const stop = Command.parse({
    id: `stop-${randomUUID()}`,
    deviceId: "person",
    payload: { type: "background_task.stop", taskId: row.id },
  });
  expect(
    pair.source.daemon.store.recordCommand(stop.id, stop.deviceId, () =>
      engine.handler.handle(stop, commandContext(pair.source.daemon.store)),
    ),
  ).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(alive(sleeper)).toBe(false), { timeout: 15_000 });
  await vi.waitFor(() => expect(state(pair)?.state).toBe("done"), { timeout: 15_000 });
  expect(rows(pair).map((entry) => entry.status)).toEqual(["stopped"]);
}, 40_000);

it("a job its machine no longer has (it restarted) lets go of the calling thread", async () => {
  const pair = await commandsAllowed();
  await startJob(pair, "sleep 60");
  await endTurn(pair);
  expect(state(pair)?.state).toBe("waiting");
  await pair.restartTarget();
  await vi.waitFor(() => expect(state(pair)?.state).toBe("done"), { timeout: 20_000 });
}, 60_000);

it("a calling machine that restarts keeps holding its thread for a job still running there", async () => {
  const pair = await commandsAllowed();
  await startJob(pair, "sleep 4");
  await endTurn(pair);
  await pair.restartSource();
  expect(state(pair)?.state).toBe("waiting");
  await vi.waitFor(() => expect(state(pair)?.state).toBe("done"), { timeout: 25_000 });
}, 60_000);
