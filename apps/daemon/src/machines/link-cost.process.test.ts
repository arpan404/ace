import { createConnection, createServer, type Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ThreadId, type AgentControlOperation } from "@ace/protocol";
import { pairedMachines } from "./machine-test-support.ts";
import { machineRequest, type MachineTransport } from "./transport.ts";

/*
 * What watching a remote child costs on the wire: connections opened, calls and bytes, counted by
 * a TCP proxy between two real daemons. Polls run at `POLL_MS` so the file stays in budget; the
 * numbers are scaled to a one-second poll, the shipped default, as per-minute figures.
 */
const POLL_MS = 250;
const scale = 1000 / POLL_MS;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A TCP proxy to `port` that counts the connections and bytes passing through it. */
async function countingProxy(port: number) {
  const counts = { connections: 0, up: 0, down: 0 };
  const open = new Set<Socket>();
  const server = createServer((client) => {
    counts.connections++;
    const upstream = createConnection({ host: "127.0.0.1", port });
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => open.delete(socket));
    }
    client.on("data", (chunk: Buffer) => void (counts.up += chunk.length));
    upstream.on("data", (chunk: Buffer) => void (counts.down += chunk.length));
    client.pipe(upstream).pipe(client);
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy not listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { port: address.port, counts };
}

const Delegated = z.object({ threadId: ThreadId });
const delegation = {
  op: "delegate_task",
  requestId: "link-cost",
  task: "Count the open pull requests",
  role: "Count-pull-requests",
  provider: "claude",
  machine: "studio",
  project: "project",
} satisfies AgentControlOperation;

/** Per minute at a one-second poll, from what `window` milliseconds at `POLL_MS` saw. */
function perMinute(
  counts: { connections: number; up: number; down: number },
  calls: number,
  window: number,
) {
  const factor = 60_000 / window / scale;
  return {
    connections: Math.round(counts.connections * factor),
    calls: Math.round(calls * factor),
    bytes: Math.round((counts.up + counts.down) * factor),
  };
}

it("watching one running and one settled remote child costs few connections and calls", async () => {
  const calls: string[] = [];
  const counting: MachineTransport = (profile, body, options) => {
    calls.push(body.call.op);
    return machineRequest(profile, body, options);
  };
  const pair = await pairedMachines({
    access: "operate",
    pollMs: POLL_MS,
    sourceTransport: counting,
  });
  const target = new URL(pair.target.daemon.remoteUrl ?? "");
  const proxy = await countingProxy(Number(target.port));
  pair.route(`https://127.0.0.1:${proxy.port}/`);

  await pair.source.call({ op: "machines" });
  const threadId = Delegated.parse((await pair.source.call(delegation)).data).threadId;
  await vi.waitFor(
    () => expect(pair.target.h.inputs.get(threadId)?.join("\n")).toContain(delegation.task),
    { timeout: 15_000 },
  );
  // Polling's own connection opens with its first status read; the window measures from there.
  await vi.waitFor(() => expect(calls).toContain("status"), { timeout: 15_000 });

  const measure = async (window: number) => {
    const before = { ...proxy.counts };
    const from = calls.length;
    await new Promise((resolve) => setTimeout(resolve, window));
    return perMinute(
      {
        connections: proxy.counts.connections - before.connections,
        up: proxy.counts.up - before.up,
        down: proxy.counts.down - before.down,
      },
      calls.length - from,
      window,
    );
  };
  const running = await measure(5000);

  await pair.finishTask(threadId, delegation.task, "Three are open.");
  await vi.waitFor(
    () =>
      expect(pair.source.h.inputs.get(pair.source.caller.threadId)?.join("\n")).toContain(
        "Three are open.",
      ),
    { timeout: 15_000 },
  );
  const settled = await measure(7500);
  console.log(`link cost per minute at a 1 s poll: ${JSON.stringify({ running, settled })}`);

  // One kept-open connection carries every poll while the child runs.
  expect(running.calls).toBeGreaterThanOrEqual(30);
  expect(running.connections).toBeLessThanOrEqual(Math.ceil(running.calls / 20));
  // A settled child is re-checked, slower than every poll and never on a connection per call.
  expect(settled.calls).toBeLessThanOrEqual(6);
  expect(settled.connections).toBeLessThanOrEqual(settled.calls);
}, 30_000);
