import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Device, HostId, ThreadId, WorkspaceId } from "@ace/protocol";
import { harness, scriptFrames } from "../engine/test-support.ts";
import { ProjectStorage } from "../project-storage.ts";
import { GuestSessions, type GuestWork } from "./guest-sessions.ts";
import { TargetThreads } from "./target-threads.ts";

/*
 * Guest sessions over a real engine and store: the person's Stop, a lowered grant and a deleted
 * session against calls that are starting, running or already gone.
 */

const device = Device.parse({
  id: "linux-box-device",
  name: "Linux box",
  scopes: ["read", "operate"],
  createdAt: 1,
  lastSeenAt: 1,
  revokedAt: null,
});
const origin = {
  hostId: HostId.parse("linux-box"),
  hostName: "Linux box",
  threadId: ThreadId.parse("fix-login"),
  threadTitle: "Fix the login flow",
};
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup() {
  const h = await harness([], scriptFrames());
  const threads = new TargetThreads({
    store: h.store,
    engine: () => h.engine,
    journal: () => undefined,
    now: () => h.clock.now(),
    limit: () => undefined,
    schedule: () => () => undefined,
    report: () => undefined,
  });
  let chats = 0;
  let ids = 0;
  const guests = new GuestSessions({
    store: h.store,
    engine: () => h.engine,
    threads,
    chat: async () => {
      const path = join(h.home, "chats", `chat-${++chats}`);
      mkdirSync(path, { recursive: true });
      const chat = new ProjectStorage(h.store, () => 1).registerChat(path, "Chat");
      return { id: WorkspaceId.parse(chat.id), path };
    },
    newId: () => `call-${++ids}`,
  });
  h.engine.bindExternalTaskStop("ace-guest:", (id, thread) => guests.stop(id, thread));
  closers.push(async () => {
    threads.close();
    await h.close();
  });
  const session = await guests.open(device, origin);
  const rows = () => Object.values(h.store.snapshotThread(session.threadId).backgroundTasks);
  return { h, guests, session, rows };
}
const browsing = (ticket: number, risk: GuestWork["risk"] = "operate"): GuestWork => ({
  capability: "browser",
  risk,
  label: "browser_open from Linux box",
  ticket,
});

it("the person's Stop on the session wins over a call that was only starting", async () => {
  const { guests, session, rows } = await setup();
  const ticket = guests.ticket();
  // The call was admitted; before it registers, the person stops the session thread.
  guests.stopThread(session.threadId);
  const task = vi.fn(async () => "opened");
  await expect(
    guests.run(session, browsing(ticket), new AbortController().signal, task),
  ).rejects.toMatchObject({
    code: "unavailable",
    message: "The person stopped it on that machine.",
  });
  expect(task).not.toHaveBeenCalled();
  expect(rows().map((row) => row.status)).toEqual(["stopped"]);

  // The next call, admitted after the Stop, runs.
  await expect(
    guests.run(session, browsing(guests.ticket()), new AbortController().signal, task),
  ).resolves.toBe("opened");
});

it("a grant lowered while a call is starting refuses it, sparing reads when it went to read", async () => {
  const { guests, session } = await setup();
  const ticket = guests.ticket();
  guests.revoke({ deviceId: device.id, capability: "browser", level: "read" });
  const task = vi.fn(async () => "done");
  const signal = new AbortController().signal;
  await expect(guests.run(session, browsing(ticket), signal, task)).rejects.toMatchObject({
    code: "machine_forbidden",
    message: "The person turned this off for agents from that machine.",
  });
  expect(task).not.toHaveBeenCalled();
  // Reading was still allowed, so a reading call admitted at the same time goes on.
  await expect(guests.run(session, browsing(ticket, "read"), signal, task)).resolves.toBe("done");
  // Another machine's calls and other capabilities are untouched.
  await expect(
    guests.run(session, { ...browsing(ticket), capability: "devices" }, signal, task),
  ).resolves.toBe("done");
});

it("stopping a row no call is behind ends it instead of leaving it running", async () => {
  const { h, guests, session, rows } = await setup();
  // A row a call opened and never closed (its process went on without it).
  h.engine.guests.hold(session.threadId, "ace-guest:orphan", { title: "browser_open" });
  const [row] = rows();
  if (!row) throw new Error("No row");
  expect(row.status).toBe("running");
  expect(h.command({ type: "background_task.stop", taskId: row.id })).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(rows()[0]?.status).toBe("stopped"));
  expect(guests.ticket()).toBe(0);
});

it("a call that finishes after its session was deleted still returns its own result", async () => {
  const { h, guests, session } = await setup();
  const signal = new AbortController().signal;
  let finish: (value: string) => void = () => undefined;
  const finished = guests.run(
    session,
    browsing(guests.ticket()),
    signal,
    () => new Promise<string>((resolve) => (finish = resolve)),
  );
  // The person deletes the session while the call runs; it finishes after the thread is gone.
  await h.engine.stopForDeletion(session.threadId);
  h.store.appendEvents(
    session.threadId,
    [{ type: "thread.client.updated", changes: { deletedAt: 5, autoSettleAt: null } }],
    5,
  );
  // Storage cleanup purges a deleted thread's records.
  h.store.atomic(() => h.store.purgeThreadData(session.threadId));
  h.engine.forgetPurged(session.threadId);
  finish("page opened");
  await expect(finished).resolves.toBe("page opened");
});
