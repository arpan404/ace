import { expect, test } from "vitest";
import { Client, webSocketTransport, type Selection } from "@ace/client";
import { DeviceId, ServerMessage } from "@ace/protocol";
import { startServer } from "../server.ts";
import { harness, scriptFrames, start } from "./test-support.ts";
function when<T>(selection: Selection<T>, matches: (value: T) => boolean): Promise<T> {
  if (matches(selection.getSnapshot())) return Promise.resolve(selection.getSnapshot());
  return new Promise((resolve) => {
    const stop = selection.subscribe(() => {
      const value = selection.getSnapshot();
      if (matches(value)) {
        stop();
        resolve(value);
      }
    });
  });
}
// Mutation cases: omit reactivated agent metadata, omit ancestors, repair only on a new
// snapshot. Not executed (tests run at merge).
test("an omitted historical branch becomes visible on reactivation without reconnecting", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  const token = "a".repeat(64);
  const server = await startServer({
    port: 0,
    token,
    hostId: "reactivation",
    store: h.store,
    engine: h.engine,
    handler: h.engine.handler,
  });
  let next = 0;
  let snapshots = 0;
  const client = new Client({
    deviceId: DeviceId.parse("reactivation"),
    credential: async () => token,
    id: () => `client-${++next}`,
    random: () => 0,
    scheduler: { set: (delay, callback) => h.clock.setTimer(callback, delay) },
    storage: { load: async () => null, save: async () => {} },
    transport: () => {
      const transport = webSocketTransport(() => new WebSocket(server.url));
      return {
        ...transport,
        open(events) {
          transport.open({
            ...events,
            message(text) {
              if (ServerMessage.parse(JSON.parse(text)).type === "snapshot") snapshots++;
              events.message(text);
            },
          });
        },
      };
    },
  });
  try {
    const id = await h.create();
    const context = h.contexts[0];
    if (!context) throw new Error("Missing provider");
    for (let index = 0; index < 230; index++) {
      const key = index === 0 ? "old-parent" : index === 1 ? "old-child" : `new-${index}`;
      const ack = context.onFrame(
        frames.frame(
          {
            type: "agent.seen",
            agent: key,
            origin: "provider_subagent",
            parent: index === 1 ? "old-parent" : "root",
            fidelity: "full",
            native: { provider: "codex", nativeId: key },
            cwd: "/repo",
          },
          { type: "turn.started", agent: key, trigger: "spawn" },
          { type: "turn.ended", agent: key, outcome: "completed" },
        ),
      );
      await h.engine.flush();
      await ack;
    }
    const canonical = h.store.readEntityPage(id, "agents", Number.MAX_SAFE_INTEGER, 200);
    const older = canonical.entitiesBefore;
    if (older === null) throw new Error("Missing historical agent page");
    const page = h.store.readEntityPage(id, "agents", older, 200);
    if (page.collection !== "agents") throw new Error("Wrong collection");
    const child = page.entries.find((agent) => agent.native.nativeId === "old-child");
    const parent = page.entries.find((agent) => agent.native.nativeId === "old-parent");
    if (!child || !parent) throw new Error("Missing historical branch");
    await client.start();
    await when(client.connectionState(), (state) => state === "ready");
    const lease = client.thread(id);
    await when(
      lease.store.select(["thread"], (reader) => reader.thread?.id),
      (value) => value === id,
    );
    expect(lease.store.agent(child.id)).toBeUndefined();
    expect(lease.store.agent(parent.id)).toBeUndefined();
    const initialSnapshots = snapshots;
    const ack = context.onFrame(
      frames.frame({ type: "turn.started", agent: "old-child", trigger: "background_completion" }),
    );
    await h.engine.flush();
    await ack;
    await when(
      lease.store.select(["cursor"], (reader) => reader.cursor),
      (cursor) => cursor === h.store.headSeq(),
    );
    expect(lease.store.agent(child.id)).toMatchObject({
      parentId: parent.id,
      status: { state: "working" },
    });
    expect(lease.store.agent(parent.id)).toBeDefined();
    expect(lease.store.children(parent.id)).toContain(child.id);
    expect(snapshots).toBe(initialSnapshots);
    lease.release();
  } finally {
    await client.close();
    await server.close();
    await h.close();
  }
});
