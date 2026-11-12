import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HistorySession, HostId, ThreadId } from "@ace/protocol";
import { pastSessionProblems } from "@ace/ui-core";
import { openPastSession, PastSessionOpenRequest } from "./past-sessions.ts";

/* Opening a past CLI session from the phone, over the real SDK and the in-process fake daemon. */

const clients: ClientCore[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((owner) => owner.close()));
});

const session = (id: string, resumable: boolean) =>
  HistorySession.parse({
    id,
    instanceId: "codex",
    provider: "codex",
    nativeId: `native-${id}`,
    cwd: "/work/ace",
    title: "Earlier work",
    lastActivity: 2000,
    messageCount: 2,
    countAccuracy: "exact",
    support: { status: "supported" },
    continuation: resumable
      ? { status: "supported" }
      : { status: "unsupported", reason: "Native resume unavailable" },
  });
const transcript = [
  { role: "user" as const, text: "Start", at: 1000 },
  { role: "assistant" as const, text: "Finished", at: 2000 },
];

async function machine() {
  const daemon = new FakeDaemon({ clock: () => 5000, hostId: "mac", token: "ios-test-token" });
  daemon.seedServices({
    history: [session("resumable", true), session("frozen", false), session("lost", true)],
    historyTranscripts: { resumable: transcript, frozen: transcript },
  });
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-history-test"),
    expectedHostId: HostId.parse(daemon.hostId),
    transport: () => fakeTransport(daemon),
    credential: async () => ({ token: "ios-test-token" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  clients.push(owner);
  await owner.start();
  await until(() => (owner.state === "ready" ? owner : undefined));
  const open = (sourceId: string, action: "import" | "continue") =>
    openPastSession(
      owner,
      PastSessionOpenRequest.parse({
        type: "pastSessions.open",
        sourceId,
        workspaceId: "ace",
        action,
      }),
      new AbortController().signal,
    );
  return { daemon, open };
}

test("continuing a past session imports it, resumes it in its provider and opens its thread", async () => {
  const { daemon, open } = await machine();
  const opened = await open("resumable", "continue");
  expect(opened).toEqual({ threadId: "past-resumable", problem: null });
  expect(
    daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("past-resumable") }),
  ).toMatchObject({
    kind: "thread",
  });
});

test("a session its provider can't resume is imported but not opened, and says how to read it", async () => {
  const { open } = await machine();
  expect(await open("frozen", "continue")).toEqual({
    threadId: null,
    problem: pastSessionProblems.notContinued,
  });
  // Import alone still opens it.
  expect(await open("frozen", "import")).toEqual({ threadId: "past-frozen", problem: null });
});

test("a session whose saved conversation can't be read is never continued", async () => {
  const { open } = await machine();
  expect(await open("lost", "continue")).toEqual({
    threadId: null,
    problem: pastSessionProblems.notImported,
  });
});
