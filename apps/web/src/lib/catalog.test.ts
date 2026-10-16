import { FakeDaemon } from "@ace/fake-daemon";
import { CatalogEntry, ThreadId, WorkspaceId, ServerMessage } from "@ace/protocol";
import { waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { fakeClient } from "@/test/harness.tsx";
import { watchCatalog } from "./catalog.ts";

const tdd = CatalogEntry.parse({
  id: "codex-tdd",
  name: "tdd",
  title: "Test Driven Development",
  kind: "skill",
  description: "Write the failing test first.",
  source: { provider: "codex", scope: "global" },
  invocation: { type: "skill", name: "tdd", path: "/fixture/tdd/SKILL.md" },
});

test("an empty stale catalog becomes a recoverable error when its discovery never settles", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({ id: "cold", workspaceId: "project", provider: "codex", title: "Cold" });
  daemon.seedServices({ extensionCatalogs: { codex: [] }, catalogLoading: ["codex"] });
  const connect = daemon.connect.bind(daemon);
  let push: ((stale: boolean) => void) | undefined;
  daemon.connect = (wire) =>
    connect({
      ...wire,
      send(text) {
        const message = ServerMessage.parse(JSON.parse(text));
        if (message.type === "catalog.list.result")
          push = (stale) =>
            wire.send(
              JSON.stringify({
                type: "catalog.changed",
                requestId: message.requestId,
                entries: [],
                stale,
              }),
            );
        wire.send(text);
      },
    });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  vi.useFakeTimers();
  const initial = Promise.withResolvers<void>();
  const failure = Promise.withResolvers<void>();
  let state = "loading";
  const stop = watchCatalog(
    client,
    { threadId: ThreadId.parse("cold") },
    (_, stale) => {
      state = stale ? "loading" : "ready";
      initial.resolve();
    },
    () => {
      state = "failed";
      failure.resolve();
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(100);
    await initial.promise;
    expect(state).toBe("loading");
    await vi.advanceTimersByTimeAsync(10_000);
    await failure.promise;
    expect(state).toBe("failed");
    push?.(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(state).toBe("failed");
    push?.(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(state).toBe("ready");
  } finally {
    stop();
    vi.useRealTimers();
  }
});

test("a resubscribed thread serves its cached snapshot while its own request is held", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({ id: "cold", workspaceId: "project", provider: "codex", title: "Cold" });
  daemon.seedServices({ extensionCatalogs: { codex: [tdd] } });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const first = Promise.withResolvers<{ count: number; stale: boolean }>();
  const stopFirst = watchCatalog(
    client,
    { threadId: ThreadId.parse("cold") },
    (entries, stale) => first.resolve({ count: entries.length, stale }),
    () => first.reject(new Error("catalog failed")),
  );
  const snapshot = await first.promise;
  expect(snapshot.stale).toBe(false);
  expect(snapshot.count).toBeGreaterThan(0);
  stopFirst();
  daemon.holdRequests("catalog.list");
  const replayed: { count: number; stale: boolean }[] = [];
  const stopSecond = watchCatalog(
    client,
    { threadId: ThreadId.parse("cold") },
    (entries, stale) => void replayed.push({ count: entries.length, stale }),
    () => {
      throw new Error("a cached menu must not report failure before its held read answers");
    },
  );
  try {
    // The cached snapshot arrives synchronously, so reopening `/` never flashes loading.
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.count).toBe(snapshot.count);
  } finally {
    stopSecond();
    daemon.restoreRequests();
  }
});

test("workspace snapshots are cached per provider", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.seedServices({ extensionCatalogs: { codex: [tdd], claude: [] } });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const first = Promise.withResolvers<number>();
  const stopFirst = watchCatalog(
    client,
    { workspace: { workspaceId: WorkspaceId.parse("project"), provider: "codex" } },
    (entries) => first.resolve(entries.length),
    () => first.reject(new Error("catalog failed")),
  );
  expect(await first.promise).toBeGreaterThan(0);
  stopFirst();
  daemon.holdRequests("catalog.list");
  const replayed: number[] = [];
  const stopSecond = watchCatalog(
    client,
    { workspace: { workspaceId: WorkspaceId.parse("project"), provider: "claude" } },
    (entries) => void replayed.push(entries.length),
    () => {},
  );
  try {
    // Claude has no cached snapshot, so its menu keeps loading instead of showing codex skills.
    expect(replayed).toHaveLength(0);
  } finally {
    stopSecond();
    daemon.restoreRequests();
  }
});
