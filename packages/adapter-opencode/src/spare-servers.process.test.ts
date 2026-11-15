import { appendFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import { ThreadId, AgentId } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import { CredentialRegistry, ToolRegistry, nodeScheduler, startMcpServer } from "@ace/mcp-server";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { createOpenCodeAdapter, type ServerOptions } from "./index.ts";
import { cli, setup } from "./testing/v2-session.ts";
import { installationIdentity } from "./installation.ts";

// Real edges: each OpenCode server is a separate fake `opencode serve` process, and what this
// file guards is which of those processes run, serve whom, and when they exit.

type Tracked = { process: SupervisedProcess; gone: boolean };
async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; !condition(); tries++) {
    if (tries > 400) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
/** Lets exit callbacks that were already due run, without giving a process time to exit. */
const due = () => new Promise((resolve) => setImmediate(resolve));
/** Whether a process exits within 5 s. */
async function exits(tracked: Tracked | undefined): Promise<boolean> {
  await Promise.race([
    tracked?.process.exited,
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  return tracked?.gone ?? false;
}
/** Proof a process is running now: signal 0 reaches it and it has not reported an exit. */
function running(tracked: Tracked | undefined): boolean {
  if (!tracked?.process.pid || tracked.gone) return false;
  try {
    process.kill(tracked.process.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** An adapter whose fake OpenCode processes and per-process credentials are observed. */
async function observed(extra: ServerOptions = {}) {
  let id = 0;
  const credentials = new CredentialRegistry(() => (++id).toString(16).padStart(64, "0"));
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  registry.register({
    name: "scope",
    description: "Observe authority",
    capability: "thread_control",
    timeoutMs: 1000,
    input: z.object({}),
    output: z.object({ threadId: ThreadId }),
    async run(_input, context) {
      return { threadId: context.caller.threadId };
    },
  });
  const mcp = await startMcpServer({ registry, credentials });
  const processes: Tracked[] = [];
  // Which OpenCode process (by origin) received which ace credentials.
  const carried = new Map<string, Set<string>>();
  const bearers: string[] = [];
  const h = await setup({
    ...extra,
    runtime: {
      ...extra.runtime,
      spawn: (options) => {
        const tracked: Tracked = { process: spawnSupervised(options), gone: false };
        void tracked.process.exited.then(() => (tracked.gone = true));
        processes.push(tracked);
        return tracked.process;
      },
      fetch: (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        const seen = carried.get(url.origin) ?? new Set<string>();
        carried.set(url.origin, seen);
        const body = typeof init?.body === "string" ? init.body : "";
        for (const bearer of bearers) if (body.includes(bearer)) seen.add(bearer);
        return fetch(input, init);
      },
    },
  });
  const adapter = createOpenCodeAdapter(h.options);
  onTestFinished(async () => {
    await adapter.close();
    await mcp.close();
  });
  const open = (index: number, env?: SessionContext["env"]) => {
    const lease = credentials.issue(
      {
        sessionId: `warm-${index}`,
        threadId: ThreadId.parse(`thread-${index}`),
        agentId: AgentId.parse("root"),
        capabilities: ["thread_control"],
      },
      new AbortController().signal,
    );
    bearers.push(lease.bearer);
    return adapter.openSession({
      threadId: ThreadId.parse(`thread-${index}`),
      cwd: "/warm",
      ...(env ? { env } : {}),
      signal: new AbortController().signal,
      aceMcp: {
        url: mcp.url,
        bearer: lease.bearer,
        signal: lease.principal.signal,
        end: lease.end,
      },
      onFrame() {},
      onExit() {},
    });
  };
  const holding = (bearer: string | undefined) =>
    [...carried].find(([, seen]) => bearer !== undefined && seen.has(bearer))?.[0] ?? "";
  return { h, adapter, processes, carried, bearers, open, holding };
}

test("a scoped session opens on an already started server that never carried another session's credential", async () => {
  const o = await observed();
  const one = await o.open(0);
  // setup's own session, the first scoped session, and the spare readied after it.
  await until(() => o.carried.size === 3);
  const started = new Set(o.carried.keys());

  const two = await o.open(1);
  expect(started.has(o.holding(o.bearers[1]))).toBe(true);
  expect(o.holding(o.bearers[1])).not.toBe(o.holding(o.bearers[0]));
  for (const [, seen] of o.carried) expect(seen.size).toBeLessThanOrEqual(1);

  await one.close("shutdown");
  const response = await fetch(new URL("/test/mcp", o.holding(o.bearers[1])), {
    headers: { authorization: o.h.transport().authorization },
  });
  expect(await response.json()).toMatchObject({
    names: ["ace"],
    response: { result: { structuredContent: { threadId: "thread-1" } } },
  });
  await two.close("shutdown");
});

test("a spare stops with the last open session of its account, before that close returns, and with its adapter", async () => {
  const o = await observed();
  // Processes: 0 is setup's own session, 1 the first scoped session, 2 its spare.
  const first = await o.open(0);
  await until(() => o.processes.length === 3);
  const second = await o.open(1);
  // The second session took spare 2; its own open readied spare 3.
  await until(() => o.processes.length === 4);
  await first.close("shutdown");
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(running(o.processes[3])).toBe(true);

  // An account change stops the account's sessions, then proceeds: nothing of it may remain.
  await second.close("shutdown");
  await due();
  expect(o.processes[3]?.gone).toBe(true);

  await o.open(2);
  await until(() => o.processes.length === 6);
  expect(running(o.processes[5])).toBe(true);
  await o.adapter.close();
  await due();
  expect(o.processes[5]?.gone).toBe(true);
});

test("a spare whose OpenCode was updated or relinked since it started is stopped, and the session starts its own", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-opencode-spare-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const install = async (name: string) => {
    const path = join(root, name);
    await writeFile(path, `#!${process.execPath}\nawait import(${JSON.stringify(cli)});\n`, {
      mode: 0o755,
    });
    return path;
  };
  const link = join(root, "opencode");
  await symlink(await install("opencode-a"), link);
  const o = await observed({ discovery: { overrides: { opencode: link } } });
  const first = await o.open(0);
  await until(() => o.processes.length === 3);

  // An updater points the link at a new installation.
  const updated = await install("opencode-b");
  await rm(link);
  await symlink(updated, link);
  const second = await o.open(1);
  expect(await exits(o.processes[2])).toBe(true);
  await until(() => o.processes.length === 5);

  // An updater rewrites the installation in place.
  await appendFile(updated, "// patched\n");
  const third = await o.open(2);
  expect(await exits(o.processes[4])).toBe(true);
  for (const session of [first, second, third]) await session.close("shutdown");
});

test("closing an adapter waits for a spare it was replacing to exit", async () => {
  const o = await observed();
  // This environment's spares take 400 ms to stop once asked.
  await o.open(0, { ACE_TEST_SLOW_UNUSED_EXIT_MS: "400" });
  await until(() => o.processes.length === 3);
  // Another environment of the same configuration replaces spare 2 with its own.
  await o.open(1, { ACE_TEST_SLOW_UNUSED_EXIT_MS: "0" });
  await until(() => o.processes.length === 5);
  await o.adapter.close();
  await due();
  expect(o.processes[2]?.gone).toBe(true);
});

/** Holds the next installation check until released, so a test can act during a handoff. */
function handoffGate() {
  let armed = false;
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    arm: () => (armed = true),
    reached: reached.promise,
    release: () => released.resolve(),
    installationIdentity: async (path: string) => {
      if (armed) {
        armed = false;
        reached.resolve();
        await released.promise;
      }
      return installationIdentity(path);
    },
  };
}

test("closing the adapter while a spare is being handed over stops it before close returns, and the open fails", async () => {
  const gate = handoffGate();
  const o = await observed({ runtime: { installationIdentity: gate.installationIdentity } });
  await o.open(0);
  await until(() => o.processes.length === 3);
  gate.arm();
  const opening = o.open(1);
  await gate.reached;

  await o.adapter.close();
  await due();
  // Process 0 is setup's own adapter; every process of this adapter has exited.
  expect(o.processes.slice(1).map((tracked) => tracked.gone)).toEqual([true, true]);
  gate.release();
  await expect(opening).rejects.toThrow("OpenCode adapter is closed");
  expect(o.processes).toHaveLength(3);
});

test("the last session closing while a spare is being handed over stops it, and the opening session starts its own", async () => {
  const gate = handoffGate();
  const o = await observed({ runtime: { installationIdentity: gate.installationIdentity } });
  const first = await o.open(0);
  await until(() => o.processes.length === 3);
  gate.arm();
  const opening = o.open(1);
  await gate.reached;

  await first.close("shutdown");
  await due();
  expect(o.processes[2]?.gone).toBe(true);
  gate.release();
  const second = await opening;
  expect(running(o.processes[3])).toBe(true);
  await second.close("shutdown");
});
