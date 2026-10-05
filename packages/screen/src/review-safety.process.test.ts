import { expect, it, onTestFinished } from "vitest";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { manager, ready, target, deferred } from "./testing/support.ts";

it("takeover discards another app's input waiting behind an acknowledged native gesture", async () => {
  const blocked = deferred<void>(),
    released = deferred<void>();
  const server = createServer((socket) => {
    socket.once("data", () => blocked.resolve());
    void released.promise.then(() => socket.end("release\n"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing gate endpoint");
  const h = await manager({ FAKE_V2: "1", ACTION_GATE_PORT: String(address.port) });
  onTestFinished(async () => {
    released.resolve();
    await h.close();
    server.close();
  });
  const a = await ready(h.screen);
  const other = { ...target, bundleId: "dev.ace.other", windowId: 2 };
  await h.screen.approve(other.bundleId, true);
  const b = await h.screen.start(other);
  h.screen.controller(a.sessionId, "agent", "a");
  h.screen.controller(b.sessionId, "agent", "b");
  const drag = h.screen.input(
    a.sessionId,
    "agent",
    { kind: "pointer.drag", x: 1, y: 2, toX: 3, toY: 4 },
    "a",
  );
  const queued = expect(
    h.screen.input(b.sessionId, "agent", { kind: "text.type", text: "stale" }, "b"),
  ).rejects.toThrow("Controller changed");
  await blocked.promise;
  // A read acknowledgement drains IPC without releasing the native gesture.
  await h.screen.permissions();
  h.screen.controller(b.sessionId, "human");
  released.resolve();
  await drag;
  await queued;
  const observed = await h.screen.uiFind(b.sessionId, { query: { name: "Name" } });
  expect(observed.nodes[0]?.value).toBe("0");
});

for (const shutdown of ["revoke", "disable", "stop"] as const) {
  it(`${shutdown} during helper startup prevents a background app launch`, async () => {
    const preparing = deferred<void>(),
      release = deferred<string>();
    const env: NodeJS.ProcessEnv = { FAKE_V2: "1" };
    const h = await manager(env, {
      prepare: () => {
        preparing.resolve();
        return release.promise;
      },
    });
    onTestFinished(h.close);
    await h.screen.enable(true);
    await h.screen.approve(target.bundleId, true);
    const log = join(h.directory, "launches.jsonl");
    env.LAUNCH_LOG = log;
    // The fixture exposes launch effects independently of session existence.
    const launch = expect(
      h.screen.openAgentApp(
        target.bundleId,
        { threadId: "thread", agentId: "agent" },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    await preparing.promise;
    const stopped =
      shutdown === "revoke"
        ? h.screen.approve(target.bundleId, false)
        : shutdown === "disable"
          ? h.screen.enable(false)
          : h.screen.stopAll();
    release.resolve(process.execPath);
    await stopped;
    await launch;
    const effects = await readFile(log, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    });
    expect(effects).toBe("");
    expect(h.screen.states()).toEqual([]);
  });
}

it("concurrent starts reserve an app before helper startup finishes", async () => {
  const entered = deferred<void>(),
    release = deferred<string>();
  const h = await manager(
    { FAKE_V2: "1" },
    {
      prepare: () => {
        entered.resolve();
        return release.promise;
      },
    },
  );
  onTestFinished(h.close);
  await h.screen.enable(true);
  await h.screen.approve(target.bundleId, true);
  const first = h.screen.start(target);
  await entered.promise;
  const competing = h.screen.start(target);
  const refused = expect(competing).rejects.toMatchObject({
    code: "target_busy",
    holder: { owner: "human" },
  });
  release.resolve(process.execPath);
  await refused;
  expect((await first).lifecycle).toBe("live");
});
