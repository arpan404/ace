import { expect, test } from "vitest";
import { AgentId, Command, CommandId, ItemId, type ServerMessage } from "@ace/protocol";
import { accessRequest } from "./client-access.ts";
import { fixture, token } from "./socket-test-support.ts";
import { MaintenanceGate } from "@ace/service";
import { setup } from "./remote-test-support.ts";
import { killAll } from "./services/kill-all.ts";

type Client = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["connect"]>>;

/** The next message of a type, skipping pushes the test doesn't name. */
async function next<T extends ServerMessage["type"]>(client: Client, type: T) {
  for (;;) {
    const message = await client.next();
    if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
  }
}

const create = (id: string, workspaceId: string) => ({
  type: "command" as const,
  command: Command.parse({
    id,
    deviceId: "device",
    payload: {
      type: "thread.create",
      workspaceId,
      provider: "codex",
      title: id,
      input: [{ type: "text", text: "test" }],
    },
  }),
});

test("a paired phone pauses new work, every watching client hears it, and resuming reopens it", async () => {
  const f = await setup();
  const desk = await f.connect();
  await desk.next();
  desk.send({ type: "admission.request", requestId: "watch", operation: "status" });
  expect(await next(desk, "admission.result")).toMatchObject({
    ok: true,
    admission: { holds: [] },
  });

  const device = await f.pair(["read", "operate"]);
  const phone = await f.connectTicket(device.device.id, (await f.ticket(device.token)).ticket);
  await phone.next();
  phone.send({ type: "admission.request", requestId: "pause", operation: "pause" });
  expect(await next(phone, "admission.result")).toMatchObject({
    ok: true,
    admission: { holds: ["user"] },
  });
  expect(await next(desk, "admission.changed")).toMatchObject({ admission: { holds: ["user"] } });
  // The desktop tray reads the same gate.
  expect(await accessRequest(f.server.httpUrl, "/v1/maintenance", { token })).toMatchObject({
    draining: true,
  });
  desk.send(create("paused-create", f.workspace));
  expect(await next(desk, "error")).toMatchObject({ code: "maintenance", retryable: true });

  phone.send({ type: "admission.request", requestId: "resume", operation: "resume" });
  expect(await next(phone, "admission.result")).toMatchObject({ admission: { holds: [] } });
  expect(await next(desk, "admission.changed")).toMatchObject({ admission: { holds: [] } });
  desk.send(create("resumed-create", f.workspace));
  expect(await next(desk, "commandResult")).toMatchObject({ ok: true });
});

test("the tray's pause reaches a watching client", async () => {
  const f = await setup();
  const desk = await f.connect();
  await desk.next();
  desk.send({ type: "admission.request", requestId: "watch", operation: "status" });
  await next(desk, "admission.result");
  await accessRequest(f.server.httpUrl, "/v1/maintenance", { method: "POST", token });
  expect(await next(desk, "admission.changed")).toMatchObject({ admission: { holds: ["user"] } });
});

test("a view-only phone reads whether new work is paused but can't pause it", async () => {
  const f = await setup();
  const device = await f.pair(["read"]);
  const phone = await f.connectTicket(device.device.id, (await f.ticket(device.token)).ticket);
  await phone.next();
  phone.send({ type: "admission.request", requestId: "read", operation: "status" });
  expect(await next(phone, "admission.result")).toMatchObject({
    ok: true,
    admission: { holds: [] },
  });
  phone.send({ type: "admission.request", requestId: "pause", operation: "pause" });
  expect(await next(phone, "admission.result")).toEqual({
    type: "admission.result",
    requestId: "pause",
    ok: false,
    error: "forbidden",
  });
  expect(await accessRequest(f.server.httpUrl, "/v1/maintenance", { token })).toMatchObject({
    draining: false,
  });
});

/** A client watching admission, and a create command it can try. */
async function watcher(f: Awaited<ReturnType<typeof setup>>) {
  const device = await f.pair(["read", "operate"]);
  const phone = await f.connectTicket(device.device.id, (await f.ticket(device.token)).ticket);
  await phone.next();
  phone.send({ type: "admission.request", requestId: "watch", operation: "status" });
  await next(phone, "admission.result");
  const desk = await f.connect();
  await desk.next();
  let id = 0;
  const tryCreate = async () => {
    desk.send(create(`create-${++id}`, f.workspace));
    for (;;) {
      const message = await desk.next();
      if (message.type === "error" && message.code === "maintenance") return "refused";
      if (message.type === "commandResult") return "accepted";
    }
  };
  const ask = async (operation: "pause" | "resume") => {
    phone.send({ type: "admission.request", requestId: operation, operation });
    return (await next(phone, "admission.result")).admission;
  };
  return { phone, tryCreate, ask };
}

test("Resume from a phone can't reopen admission while an update drains it", async () => {
  const f = await setup();
  const { tryCreate, ask } = await watcher(f);
  await accessRequest(f.server.httpUrl, "/v1/maintenance/update", { method: "POST", token });
  expect(await ask("resume")).toMatchObject({ holds: ["update"] });
  expect(await tryCreate()).toBe("refused");
});

test("a drain that ends leaves the phone's pause in place", async () => {
  const f = await setup();
  const { tryCreate, ask } = await watcher(f);
  await accessRequest(f.server.httpUrl, "/v1/maintenance/update", { method: "POST", token });
  expect(await ask("pause")).toMatchObject({ holds: ["update", "user"] });
  await accessRequest(f.server.httpUrl, "/v1/maintenance/update", { method: "DELETE", token });
  expect(await tryCreate()).toBe("refused");
  expect(await ask("resume")).toMatchObject({ holds: [] });
  expect(await tryCreate()).toBe("accepted");
});

/** Kill-all on the fixture's thread, held open until `finish` runs. */
function killing(f: Awaited<ReturnType<typeof setup>>) {
  const { promise: cleaned, resolve: finish } = Promise.withResolvers<void>();
  const run = killAll(
    {
      maintenance: f.server.maintenance,
      device: () => "device",
      options: {
        store: f.store,
        engine: {
          cleanupThreads: (id) => [id],
          hasUnfinishedWork: () => false,
          cleanupSession: () => cleaned,
          stopForCancellation: async () => {},
          flush: async () => {},
        },
        agentControl: {
          delegations: {
            cancelMember: () => {},
            command: (id) => ({ commandId: CommandId.parse(id), ok: true }),
          },
        },
      },
    },
    { op: "process.kill_all", key: `kill-${f.thread.id}`, threadId: f.thread.id },
  );
  return { run, finish };
}

test("Resume from a phone can't reopen admission while kill-all holds it", async () => {
  const f = await setup();
  const { tryCreate, ask } = await watcher(f);
  const kill = killing(f);
  expect(await ask("resume")).toMatchObject({ holds: ["kill"] });
  expect(await tryCreate()).toBe("refused");
  kill.finish();
  expect(await kill.run).toMatchObject({ ok: true });
  expect(await tryCreate()).toBe("accepted");
});

test("kill-all ending leaves the phone's pause in place", async () => {
  const f = await setup();
  const { tryCreate, ask } = await watcher(f);
  const kill = killing(f);
  expect(await ask("pause")).toMatchObject({ holds: ["kill", "user"] });
  kill.finish();
  await kill.run;
  expect(await tryCreate()).toBe("refused");
});

test("kill-all started while the person had already paused leaves the pause in place", async () => {
  const f = await setup();
  const { tryCreate, ask } = await watcher(f);
  expect(await ask("pause")).toMatchObject({ holds: ["user"] });
  const kill = killing(f);
  kill.finish();
  expect(await kill.run).toMatchObject({ ok: true });
  expect(f.server.maintenance.status().holds).toEqual(["user"]);
  expect(await tryCreate()).toBe("refused");
});

test("while paused, a watching phone hears what is still finishing and what waits on a person", async () => {
  const f = await setup();
  const { phone, ask } = await watcher(f);
  expect(await ask("pause")).toMatchObject({ busy: 0, waiting: 0 });
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", status: { state: "working", agents: 1 } },
  ]);
  expect(await next(phone, "admission.changed")).toMatchObject({
    admission: { holds: ["user"], busy: 1, waiting: 0 },
  });
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
  ]);
  expect(await next(phone, "admission.changed")).toMatchObject({
    admission: { busy: 1, waiting: 1 },
  });
});

test("while paused, a burst of deltas and title changes never recounts, and a status change recounts once", async () => {
  let recounts = 0;
  const f = await fixture({}, (store) => ({
    maintenanceGate: new MaintenanceGate(
      () => {
        recounts++;
        return store.updateBlockers();
      },
      () => store.waitingBlockers(),
    ),
  }));
  try {
    const desk = await f.connect();
    await desk.next();
    desk.send({ type: "admission.request", requestId: "pause", operation: "pause" });
    await next(desk, "admission.result");
    recounts = 0;
    for (let index = 0; index < 50; index++)
      f.store.appendEvents(f.thread.id, [
        {
          type: "item.delta",
          itemId: ItemId.parse("streaming"),
          agentId: AgentId.parse("root"),
          field: "text",
          append: ` word ${index}`,
        },
        { type: "thread.updated", title: `Title ${index}` },
      ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recounts).toBe(0);
    f.store.appendEvents(f.thread.id, [
      { type: "thread.updated", status: { state: "working", agents: 1 } },
    ]);
    expect(await next(desk, "admission.changed")).toMatchObject({ admission: { busy: 1 } });
    expect(recounts).toBe(1);
  } finally {
    await f.close();
  }
});
