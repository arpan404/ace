import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { readConfig } from "./config.ts";
import { AdapterRegistry, startDaemon } from "./index.ts";
import { Client } from "./socket-test-support.ts";
import { Capabilities, Command, ItemId, ThreadId } from "@ace/protocol";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
test("authenticated history import publishes a daemon thread with windowed canonical history", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-history-daemon-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "claude"),
    cwd = "/repo/history";
  await mkdir(join(home, "projects/p"), { recursive: true });
  await writeFile(
    join(home, "projects/p/native.jsonl"),
    JSON.stringify({
      type: "user",
      sessionId: "native",
      cwd,
      message: { role: "user", content: "existing history" },
    }) + "\n",
  );
  const config = readConfig({
    ACE_HOME: join(root, "ace"),
    ACE_PORT: "0",
    ACE_LOG_LEVEL: "silent",
  });
  // The sixth argument supplies registered homes; before the fix it is ignored.
  const daemon = await startDaemon({
    config: config,
    toolkits: [],
    modelInstances: [],
    engine: { registry: new AdapterRegistry() },
    history: {
      instances: [{ id: "account", provider: "claude", homeDir: home }],
    },
  });
  await daemon.history?.startScan();
  cleanup.unshift(daemon.close);
  const client = new Client(daemon.url);
  cleanup.unshift(() => client.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: (await import("@ace/protocol")).DeviceId.parse("host-client"),
    token: await readFile(daemon.tokenPath, "utf8"),
  });
  expect((await client.next()).type).toBe("welcome");
  client.socket.send(JSON.stringify({ type: "history.list", cwd }));
  const listing = await client.next();
  expect(listing.type).toBe("history.list");
  if (listing.type !== "history.list") throw new Error("Missing history route");
  const source = listing.sessions[0];
  if (!source) throw new Error("Missing source");
  const workspaceId = daemon.store.createWorkspace(cwd, "History");
  client.socket.send(JSON.stringify({ type: "history.import", sourceId: source.id, workspaceId }));
  const imported = await client.next();
  expect(imported.type).toBe("history.import");
  if (imported.type !== "history.import" || imported.status !== "imported")
    throw new Error("Import failed");
  const threadId = ThreadId.parse(imported.threadId);
  expect(daemon.store.getThread(threadId)?.imported).toMatchObject({
    instanceId: "account",
    native: { nativeId: "native" },
  });
  expect(daemon.store.snapshotThread(threadId).itemOrder).toHaveLength(1);
  const item = Object.values(daemon.store.snapshotThread(threadId).items)[0];
  expect(item).toMatchObject({
    type: "message",
    parts: [{ type: "text", text: "existing history" }],
  });
  client.socket.send(JSON.stringify({ type: "history.import", sourceId: source.id, workspaceId }));
  expect(await client.next()).toMatchObject({
    type: "history.import",
    status: "imported",
    threadId,
  });
  // Imported threads have persisted events and no live engine snapshot (I17).
  const command = Command.parse({
    id: "archive-imported",
    deviceId: "host-client",
    payload: { type: "thread.archive", threadId },
  });
  const beforeArchive = daemon.store.headSeq();
  for (let retry = 0; retry < 2; retry++) {
    client.send({ type: "command", command });
    expect(await client.next()).toMatchObject({
      type: "commandResult",
      commandId: command.id,
      ok: true,
    });
  }
  expect(daemon.store.getThread(threadId)?.archivedAt).toBeTypeOf("number");
  expect(daemon.store.readEvents({ afterSeq: beforeArchive, limit: 10 })).toHaveLength(1);
});

test("native continuation uses the registered home-bound adapter and persists its live output", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-history-resume-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "account-two"),
    cwd = "/repo/history";
  await mkdir(join(home, "projects/p"), { recursive: true });
  await writeFile(
    join(home, "projects/p/native.jsonl"),
    JSON.stringify({
      type: "user",
      sessionId: "native",
      cwd,
      message: { role: "user", content: "history" },
    }) + "\n",
  );
  let store: import("./store.ts").Store | undefined;
  let closed = false;
  let liveSeq = 0;
  let exitDuringOpen = true;
  const adapter: import("@ace/engine-api").ProviderAdapter = {
    provider: "claude",
    capabilities: () =>
      Capabilities.parse({
        // This scripted history provider accepts the explicit engine auto-review contract.
        permissions: { modes: ["auto-review"], nativeAutoReview: false, toolGate: false },
        steer: false,
        interruptCascades: false,
        resume: true,
        fork: true,
        subagentTranscripts: false,
        backgroundTaskControl: false,
        backgroundVisibility: "none",
        planMode: false,
        tokenUsage: false,
        imageInput: false,
        rewindFiles: false,
      }),
    createTranslator: () => ({ translate: () => [], tick: () => [] }),
    async openSession(ctx) {
      const native = ctx.resume?.nativeSessionId ?? "unexpected-new-session";
      if (exitDuringOpen) {
        exitDuringOpen = false;
        ctx.onExit({ deliberate: false, message: "startup failed" });
      }
      return {
        nativeSessionId: native,
        async send(input) {
          if (ctx.signal.aborted) throw new Error("Provider session aborted");
          await writeFile(
            join(home, "fake-cli-receipt"),
            JSON.stringify({ native, cwd: ctx.cwd, input }),
          );
          ctx.onFrame({
            seq: ++liveSeq,
            t: 0,
            dir: "recv",
            channel: "test-cli",
            data: "continued reply",
          });
        },
        async interrupt() {},
        async resolve() {},
        async stopTask() {},
        async close() {
          closed = true;
        },
      };
    },
  };
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: join(root, "ace"), ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    toolkits: [],
    modelInstances: [],
    engine: { registry: new AdapterRegistry() },
    history: {
      instances: [{ id: "account-two", provider: "claude", homeDir: home }],
      adapters: {
        resolve: (instance) => (instance === "account-two" ? adapter : undefined),
        fork: async (input) => {
          await appendFile(join(home, "fake-fork-receipt"), JSON.stringify(input) + "\n");
          return "forked-native";
        },
        onFrame(threadId, instanceId, frame) {
          if (!store) throw new Error("Missing engine store");
          const thread = store.getThread(threadId);
          if (!thread?.rootAgentId) throw new Error("Missing imported root");
          store.appendEvents(threadId, [
            {
              type: "item.created",
              item: {
                type: "notice",
                id: ItemId.parse(`live-${liveSeq}`),
                agentId: thread.rootAgentId,
                createdAt: 10,
                complete: true,
                level: "info",
                text: `${instanceId}: ${String(frame.data)}`,
                raw: [],
              },
            },
          ]);
        },
        onExit() {},
      },
    },
  });
  store = daemon.store;
  await daemon.history?.startScan();
  cleanup.unshift(daemon.close);
  const client = new Client(daemon.url);
  cleanup.unshift(() => client.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: (await import("@ace/protocol")).DeviceId.parse("client"),
    token: await readFile(daemon.tokenPath, "utf8"),
  });
  await client.next();
  client.send({ type: "history.list", cwd, limit: 50 });
  const listing = await client.next();
  if (listing.type !== "history.list" || !listing.sessions[0]) throw new Error("Missing history");
  client.send({
    type: "history.import",
    sourceId: listing.sessions[0].id,
    workspaceId: store.createWorkspace(cwd, "History"),
  });
  const imported = await client.next();
  if (imported.type !== "history.import" || imported.status !== "imported")
    throw new Error("Missing imported thread");
  client.send({
    type: "history.continue",
    threadId: imported.threadId,
    mode: "resume",
    input: [{ type: "text", text: "startup request" }],
    delivery: "queue",
  });
  expect(await client.next()).toMatchObject({ type: "error", code: "history_rejected" });
  for (const mode of ["fork", "resume"] as const) {
    client.send({
      type: "history.continue",
      threadId: imported.threadId,
      mode,
      input: [{ type: "text", text: "continue prompt" }],
      delivery: "queue",
    });
    expect(await client.next()).toMatchObject({
      type: "history.continue",
      status: "continued",
      instanceId: "account-two",
      nativeSessionId: "forked-native",
    });
  }
  expect(JSON.parse(await readFile(join(home, "fake-cli-receipt"), "utf8"))).toEqual({
    native: "forked-native",
    cwd,
    input: [{ type: "text", text: "continue prompt" }],
  });
  expect(JSON.parse(await readFile(join(home, "fake-fork-receipt"), "utf8"))).toEqual({
    instanceId: "account-two",
    nativeSessionId: "native",
  });
  client.send({
    type: "history.continue",
    threadId: imported.threadId,
    mode: "fork",
    input: [{ type: "text", text: "must be rejected" }],
    delivery: "queue",
  });
  expect(await client.next()).toMatchObject({ type: "error", code: "history_rejected" });
  expect((await readFile(join(home, "fake-fork-receipt"), "utf8")).trim().split("\n")).toHaveLength(
    1,
  );
  const snapshot = store.snapshotThread(imported.threadId);
  expect(
    Object.values(snapshot.items).filter(
      (i) => i.type === "notice" && i.text === "account-two: continued reply",
    ),
  ).toHaveLength(2);
  expect(Object.values(snapshot.agents)[0]?.native.nativeId).toBe("forked-native");
  await client.close();
  const reconnected = new Client(daemon.url);
  cleanup.unshift(() => reconnected.close());
  await once(reconnected.socket, "open");
  reconnected.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: (await import("@ace/protocol")).DeviceId.parse("client"),
    token: await readFile(daemon.tokenPath, "utf8"),
  });
  expect((await reconnected.next()).type).toBe("welcome");
  reconnected.send({
    type: "history.continue",
    threadId: imported.threadId,
    mode: "resume",
    input: [{ type: "text", text: "after reconnect" }],
    delivery: "queue",
  });
  expect(await reconnected.next()).toMatchObject({
    type: "history.continue",
    status: "continued",
    nativeSessionId: "forked-native",
  });
  expect(
    Object.values(store.snapshotThread(imported.threadId).items).filter(
      (i) => i.type === "notice" && i.text === "account-two: continued reply",
    ),
  ).toHaveLength(3);
  await reconnected.close();
  await daemon.close();
  expect(closed).toBe(true);
});
