import "./test-host.ts";
import { ClientCore } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, Notification, ThreadId } from "@ace/protocol";
import { expect, vi } from "vitest";
import type { KeptValue } from "./kept-value.ts";
import { NotificationAction, NotificationBridge } from "./notifications.ts";

const closers: (() => Promise<void>)[] = [];
/** Closes every phone this test opened; call it from `afterEach`. */
export async function closePhones(): Promise<void> {
  for (const close of closers.splice(0)) await close();
}
export const threadId = ThreadId.parse("approval");
export function schedule(delay: number, run: () => void) {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
}
export const alert = (id: string) =>
  Notification.parse({
    id,
    threadId,
    title: "Fix the flaky queue test",
    status: "done",
    backgroundCount: 0,
    actions: [],
  });

/** The real SDK against the fixture daemon; patches are what Swift would receive. */
export async function phone(now?: () => number, runProgress?: KeptValue) {
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
  const watchers: ((patch: Record<string, unknown>) => void)[] = [];
  const bridge = new NotificationBridge(
    client,
    (_key, read) => {
      const patch = read();
      if (!patch) return;
      patches.push(patch);
      for (const watch of watchers) watch(patch);
    },
    schedule,
    () => 23 * 60,
    200,
    undefined,
    now,
    runProgress,
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
  /** Lets queued register/unregister requests go out, then waits for the daemon to answer. */
  const settle = async () => {
    await new Promise((done) => setTimeout(done, 10));
    await barrier();
  };
  /** Runs `watch` as each patch reaches Swift, before the test reads it. */
  const watch = (watcher: (patch: Record<string, unknown>) => void) => watchers.push(watcher);
  return { daemon, act, sync, resolve, barrier, settle, of, interactions, watch };
}
