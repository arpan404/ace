import { ClientCore } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, Notification, ThreadId } from "@ace/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationAction, NotificationBridge } from "./notifications.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
const threadId = ThreadId.parse("approval");
function schedule(delay: number, run: () => void) {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
}
const alert = (id: string) =>
  Notification.parse({
    id,
    threadId,
    title: "Fix the flaky queue test",
    status: "done",
    backgroundCount: 0,
    actions: [],
  });

/** The real SDK against the fixture daemon; patches are what Swift would receive. */
async function phone() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({
    id: threadId,
    workspaceId: "ace",
    title: "Fix the flaky queue test",
    provider: "codex",
    access: "ask",
  });
  daemon.apply(threadId, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "push",
      blocking: true,
      request: {
        kind: "approval",
        title: "Codex wants to run a command",
        options: [
          { id: "deny", label: "Deny", kind: "deny" },
          { id: "allow", label: "Allow", kind: "allow_once" },
        ],
      },
    },
  ]);
  const interactions = () => {
    const view = daemon.snapshot({ kind: "thread", threadId });
    return view?.kind === "thread" ? Object.values(view.interactions) : [];
  };
  const interactionId = interactions()[0]?.id ?? "";
  let saved: string | null = null;
  let sequence = 0;
  const client = new ClientCore({
    deviceId: DeviceId.parse("phone"),
    transport: () => fakeTransport(daemon),
    storage: {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
    credential: async () => daemon.token,
    scheduler: { set: schedule },
    random: () => 0,
    id: () => `id-${++sequence}`,
  });
  const patches: Record<string, unknown>[] = [];
  const bridge = new NotificationBridge(
    client,
    (_key, read) => {
      const patch = read();
      if (patch) patches.push(patch);
    },
    schedule,
    200,
  );
  closers.push(async () => {
    bridge.close();
    await client.close();
  });
  await client.start();
  await vi.waitFor(() => expect(client.state).toBe("ready"));
  const act = (action: unknown) => bridge.handle(NotificationAction.parse(action));
  const sync = (enabled: boolean, cursor = 0) =>
    act({ type: "notifications.sync", enabled, appState: "foreground", cursor });
  const resolve = (requestId: string, optionId: string) =>
    act({ type: "notifications.resolve", requestId, threadId, interactionId, optionId });
  /** Frames are ordered: once this round trip returns, earlier pushes have been handled. */
  const barrier = () => client.request({ type: "notification.config" });
  const of = (type: string) => patches.filter((patch) => patch.type === type);
  return { daemon, act, sync, resolve, barrier, of, interactions };
}

it("posts the daemon's live alerts only while notifications are on", async () => {
  const { daemon, sync, barrier, of } = await phone();
  sync(false);
  daemon.notify(alert("n:1"));
  await barrier();
  sync(true);
  daemon.notify(alert("n:2"));
  await vi.waitFor(() => expect(of("notifications.alert")).toHaveLength(1));
  expect(of("notifications.alert")[0]).toMatchObject({ notification: { id: "n:2" } });
});

it("catches up on what the daemon sent while the app wasn't listening, once per cursor", async () => {
  const { daemon, sync, of } = await phone();
  daemon.notify(alert("n:1"));
  sync(true);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(1));
  expect(of("notifications.feed")[0]).toMatchObject({
    cursor: 1,
    entries: [{ id: "n:1" }],
    retracted: [],
  });
  daemon.retractNotification("n:1");
  sync(true, 1);
  await vi.waitFor(() => expect(of("notifications.feed")).toHaveLength(2));
  expect(of("notifications.feed")[1]).toMatchObject({ entries: [], retracted: ["n:1"] });
});

it("an approval action answers the exact pending option once, through the durable command path", async () => {
  const { resolve, of, interactions } = await phone();
  resolve("tap-1", "allow");
  // The receipt may beat the admission callback; either way the last word is the daemon's.
  await vi.waitFor(() =>
    expect(of("notifications.action").at(-1)).toMatchObject({ id: "tap-1", outcome: "confirmed" }),
  );
  await new Promise((done) => setTimeout(done, 20));
  expect(of("notifications.action").at(-1)).toMatchObject({ outcome: "confirmed" });
  expect(interactions()[0]).toMatchObject({
    state: "resolved",
    resolution: { kind: "approval", optionId: "allow" },
  });
  // The same alert tapped again finds nothing pending and sends nothing.
  resolve("tap-2", "allow");
  const before = of("notifications.action").length;
  await vi.waitFor(() => expect(of("notifications.action")).toHaveLength(before + 1));
  expect(of("notifications.action").at(-1)).toEqual({
    type: "notifications.action",
    id: "tap-2",
    outcome: "stale",
  });
});

it("an action for an option the approval doesn't offer sends nothing", async () => {
  const { resolve, of, interactions } = await phone();
  resolve("tap", "always");
  await vi.waitFor(() => expect(of("notifications.action")).toHaveLength(1));
  expect(of("notifications.action")[0]).toMatchObject({ outcome: "stale" });
  expect(interactions()[0]?.state).toBe("pending");
});
