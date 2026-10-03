import { mkdtemp, mkdir, writeFile, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Capabilities, DeviceId, ItemId, ThreadId, type ServerMessage } from "@ace/protocol";
import type { SessionContext, ProviderAdapter } from "@ace/engine-api";
import { startDaemon, readConfig } from "./index.ts";
import { Client } from "./socket-test-support.ts";

/** Fake provider transport only; sockets, history workers and event persistence are real. */
export async function reviewFixture(backpressure = true) {
  const root = await mkdtemp(join(tmpdir(), "ace-history-review-"));
  const home = join(root, "provider"),
    cwd = "/review";
  await mkdir(join(home, "projects/p"), { recursive: true });
  for (const native of ["A", "other"])
    await writeFile(
      join(home, "projects/p", native + ".jsonl"),
      JSON.stringify({
        type: "user",
        sessionId: native,
        cwd,
        customTitle: native,
        message: { role: "user", content: `history ${native}` },
      }) + "\n",
    );
  let store: import("./store.ts").Store | undefined;
  const sessions = new Map<string, SessionContext>();
  let fork = 0,
    seq = 0;
  let paused: Promise<void> | undefined;
  let pauseHold:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        proceed: ReturnType<typeof Promise.withResolvers<void>>;
        released: ReturnType<typeof Promise.withResolvers<void>>;
        aborted: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  const adapter: ProviderAdapter = {
    provider: "claude",
    capabilities: () =>
      Capabilities.parse({
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
      const native = ctx.resume?.nativeSessionId ?? "unexpected";
      sessions.set(native, ctx);
      return {
        nativeSessionId: native,
        async send(input) {
          await appendFile(
            join(root, "send-receipts.jsonl"),
            JSON.stringify({ native, input }) + "\n",
          );
        },
        async close() {},
        async interrupt() {},
        async resolve() {},
        async stopTask() {},
      };
    },
  };
  const persist = (threadId: ThreadId, text: string) => {
    const thread = store?.getThread(threadId);
    if (!store || !thread?.rootAgentId) throw new Error("Missing live thread");
    store.appendEvents(threadId, [
      {
        type: "item.created",
        item: {
          type: "notice",
          id: ItemId.parse(`live-${++seq}`),
          agentId: thread.rootAgentId,
          createdAt: 1,
          complete: true,
          level: "info",
          text,
          raw: [],
        },
      },
    ]);
  };
  const config = readConfig({
    ACE_HOME: join(root, "ace"),
    ACE_PORT: "0",
    ACE_LOG_LEVEL: "silent",
  });
  const options = {
    instances: [{ id: "account", provider: "claude" as const, homeDir: home }],
    adapters: {
      resolve: () => adapter,
      async fork(input: { instanceId: string; nativeSessionId: string }) {
        await appendFile(join(root, "fork-receipts.jsonl"), JSON.stringify(input) + "\n");
        return `fork-${++fork}`;
      },
      onFrame(threadId: ThreadId, _instance: string, frame: import("@ace/engine-api").Frame) {
        persist(threadId, String(frame.data));
      },
      onExit(
        threadId: ThreadId,
        _instance: string,
        outcome: { deliberate: boolean; message?: string },
      ) {
        persist(threadId, `exit: ${outcome.message}`);
      },
      ...(backpressure
        ? {
            async pausePersistence(signal: AbortSignal) {
              const gate = Promise.withResolvers<void>();
              paused = gate.promise;
              const hold = pauseHold;
              if (hold) {
                const onAbort = () => hold.aborted.resolve();
                signal.addEventListener("abort", onAbort, { once: true });
                if (signal.aborted) onAbort();
                hold.entered.resolve();
                await hold.proceed.promise;
                signal.removeEventListener("abort", onAbort);
              }
              return async () => {
                paused = undefined;
                gate.resolve();
                pauseHold = undefined;
                hold?.released.resolve();
              };
            },
          }
        : {}),
    },
  };
  let daemon = await startDaemon({
    config: config,
    toolkits: [],
    notificationChannels: {},
    modelInstances: [],
    history: options,
  });
  store = daemon.store;
  const clients: Client[] = [];
  async function connect() {
    const client = new Client(daemon.url);
    clients.push(client);
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("review"),
      token: await readFile(daemon.tokenPath, "utf8"),
    });
    const welcome = await client.next();
    if (welcome.type !== "welcome") throw new Error("Missing welcome");
    return client;
  }
  const client = await connect();
  client.send({ type: "history.list", cwd, limit: 50 });
  const listing = await client.next();
  if (listing.type !== "history.list") throw new Error("Missing list");
  const sources = listing.sessions;
  const workspaceId = store.createWorkspace(cwd, "Review");
  function importRequest(requester: Client, native: string) {
    const source = sources.find((s) => s.nativeId === native);
    if (!source) throw new Error("Missing source");
    requester.send({ type: "history.import", sourceId: source.id, workspaceId });
    return requester.next();
  }
  const imported = await importRequest(client, "A");
  if (imported.type !== "history.import" || imported.status !== "imported")
    throw new Error("Missing import");
  const threadId = imported.threadId;
  async function continueThread(mode: "fork" | "resume", c = client): Promise<ServerMessage> {
    c.send({
      type: "history.continue",
      threadId,
      mode,
      input: [{ type: "text", text: "work on current branch" }],
      delivery: "queue",
    });
    return c.next();
  }
  async function emit(native: string, text: string) {
    // A transport applies backpressure at the callback boundary, without a queue.
    let gate = paused;
    while (gate) {
      await gate;
      gate = paused;
    }
    const ctx = sessions.get(native);
    if (!ctx) throw new Error("Missing native session");
    ctx.onFrame({ seq: seq + 1, t: 0, dir: "recv", channel: "provider", data: text });
  }
  async function exit(native: string) {
    let gate = paused;
    while (gate) {
      await gate;
      gate = paused;
    }
    const ctx = sessions.get(native);
    if (!ctx) throw new Error("Missing native session");
    ctx.onExit({ deliberate: false, message: "native finished" });
    sessions.delete(native);
  }
  return {
    root,
    client,
    threadId,
    connect,
    continueThread,
    importRequest,
    emit,
    exit,
    holdNextPause() {
      if (pauseHold) throw new Error("Already holding persistence pause");
      pauseHold = {
        entered: Promise.withResolvers<void>(),
        proceed: Promise.withResolvers<void>(),
        released: Promise.withResolvers<void>(),
        aborted: Promise.withResolvers<void>(),
      };
      return pauseHold;
    },
    get store() {
      return daemon.store;
    },
    async restart() {
      for (const c of clients.splice(0)) await c.close();
      await daemon.close();
      sessions.clear();
      daemon = await startDaemon({
        config: config,
        toolkits: [],
        notificationChannels: {},
        modelInstances: [],
        history: options,
      });
      store = daemon.store;
      return connect();
    },
    async close() {
      pauseHold?.proceed.resolve();
      for (const c of clients.splice(0)) await c.close();
      await daemon.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
