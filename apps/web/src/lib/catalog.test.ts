import { FakeDaemon } from "@ace/fake-daemon";
import { ThreadId, ServerMessage } from "@ace/protocol";
import { waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { fakeClient } from "@/test/harness.tsx";
import { watchCatalog } from "./catalog.ts";

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
