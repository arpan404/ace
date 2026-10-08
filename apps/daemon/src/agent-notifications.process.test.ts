import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Agent, Command, DeviceId, type Notification } from "@ace/protocol";
import { createDaemonNotifications } from "./notifications.ts";
import { startDaemonMcp } from "./mcp.ts";
import { fixture } from "./socket-test-support.ts";
import { invoke, Result } from "./browser-mcp-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "ace-agent-notify-"));
  const f = await fixture();
  const notices: Notification[] = [];
  const errors: unknown[] = [];
  const create = () => {
    const service = createDaemonNotifications(home, f.store, (error) => errors.push(error), {}, 0);
    service.setSender((_device, notification) => {
      notices.push(notification);
      return true;
    });
    return service;
  };
  let notifications = create();
  await notifications.ready();
  await notifications.service.register(DeviceId.parse("browser"), {
    channel: "websocket",
    platform: "web",
  });
  const agent = Agent.parse({
    id: "root",
    threadId: f.thread.id,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: home,
    status: { state: "idle" },
    createdAt: 1,
  });
  f.store.appendEvents(f.thread.id, [{ type: "agent.created", agent }]);
  const mcp = await startDaemonMcp(f.store);
  const lease = mcp.openSession(
    { threadId: f.thread.id, agentId: agent.id, sessionId: "test", capabilities: ["notify"] },
    new AbortController().signal,
  );
  const client = await f.connect();
  await client.next();
  cleanup.push(async () => {
    await mcp.close();
    await notifications.close();
    await f.close();
    await rm(home, { recursive: true, force: true });
  });
  const say = async (text: string) => {
    const result = Result.parse(
      await (
        await invoke({ url: mcp.url, bearer: lease.bearer }, "ace_notify_user", { text })
      ).json(),
    );
    expect(result.result.isError).not.toBe(true);
  };
  const snooze = async (until: number | null, id: string) => {
    client.send({
      type: "command",
      command: Command.parse({
        id,
        deviceId: "device",
        payload: { type: "thread.snooze", threadId: f.thread.id, until },
      }),
    });
    expect(await client.next()).toMatchObject({ type: "commandResult", ok: true });
  };
  return {
    ...f,
    notices,
    errors,
    say,
    snooze,
    get notifications() {
      return notifications;
    },
    async restart() {
      await notifications.close();
      notifications = create();
      await notifications.ready();
    },
  };
}

test("ace_notify_user reaches notification delivery and recovery does not repeat an accepted intent", async () => {
  const f = await setup();
  await f.say("The preview is ready for you.");
  await f.notifications.tick();
  expect(f.notices).toEqual([
    expect.objectContaining({
      status: "agent_says",
      title: f.thread.title,
      threadId: f.thread.id,
      message: "The preview is ready for you.",
    }),
  ]);
  expect(f.store.readMcpIntents()).toEqual([]);
  await f.notifications.tick();
  expect(f.notices).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

test("thread Snooze silences status and agent notices and waking permits new notices", async () => {
  const f = await setup();
  await f.snooze(Date.now() + 3_600_000, "snooze");
  await f.restart();
  await f.say("This should stay quiet.");
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", status: { state: "working", agents: 1 } },
    { type: "thread.updated", status: { state: "failed" } },
  ]);
  await f.notifications.tick();
  expect(f.notices).toEqual([]);
  await f.snooze(null, "wake");
  await f.say("You can hear this one.");
  await f.notifications.tick();
  expect(f.notices).toEqual([
    expect.objectContaining({ status: "agent_says", message: "You can hear this one." }),
  ]);
  expect(f.errors).toEqual([]);
});

test("turning Agent says off silences agent notices without silencing failures", async () => {
  const f = await setup();
  await f.notifications.service.preferences(DeviceId.parse("browser"), { agentSays: false });
  await f.say("No alert for this.");
  f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: { state: "failed" } }]);
  await f.notifications.tick();
  expect(f.notices).toEqual([expect.objectContaining({ status: "failed" })]);
  expect(f.errors).toEqual([]);
});

test("restarting between durable notice acceptance and intent acknowledgment delivers it once", async () => {
  const f = await setup();
  await f.say("Accepted before restart.");
  const entry = f.store.readMcpIntents(1, "mcp.notify")[0];
  if (!entry || entry.intent.type !== "mcp.notify") throw new Error("Missing notify intent");
  await f.notifications.service.notify({
    id: `mcp:${entry.id}`,
    threadId: f.thread.id,
    title: f.thread.title,
    status: "agent_says",
    message: entry.intent.notice.text,
    backgroundCount: 0,
    actions: [],
  });
  await f.notifications.service.drain();
  expect(f.notices).toHaveLength(1);
  await f.restart();
  await f.notifications.tick();
  expect(f.notices).toEqual([expect.objectContaining({ message: "Accepted before restart." })]);
  expect(f.store.readMcpIntents()).toEqual([]);
  expect(f.errors).toEqual([]);
});
