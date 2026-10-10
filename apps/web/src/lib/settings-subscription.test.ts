import { FakeDaemon } from "@ace/fake-daemon";
import { expect, test, vi } from "vitest";
import { fakeClient } from "@/test/harness.tsx";
import { daemonValues } from "@/features/settings/data/daemon-values.ts";
import { waitFor } from "@testing-library/react";

test("independent settings mirrors on one socket keep their values and cannot unsubscribe each other", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const client = fakeClient(daemon);
  await client.start();
  const first = daemonValues(client, ["threads.useWorktree", "threads.autoSettleAfter"]);
  const second = daemonValues(client, ["threads.useWorktree"]);
  const stopFirst = first.subscribe(() => {});
  const stopSecond = second.subscribe(() => {});
  try {
    await waitFor(() => expect(first.get()["threads.autoSettleAfter"]).toBeDefined());
    await waitFor(() => expect(second.get()["threads.useWorktree"]).toBeDefined());
    stopSecond();
    await first.set("threads.useWorktree", false);
    await waitFor(() => expect(first.get()["threads.useWorktree"]).toBe(false));
    expect(first.get()["threads.autoSettleAfter"]).toBeDefined();
    await client.request({
      type: "settings.set",
      key: "threads.useWorktree",
      value: true,
      layer: { kind: "global" },
    });
    await waitFor(() => expect(first.get()["threads.useWorktree"]).toBe(true));
  } finally {
    stopFirst();
  }
});

test("a failed first settings subscription retries while the connection stays ready", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const client = fakeClient(daemon);
  await client.start();
  daemon.failRequests("settings.subscribe");
  const values = daemonValues(client, ["threads.useWorktree"]);
  vi.useFakeTimers();
  const stop = values.subscribe(() => {});
  try {
    await vi.waitFor(() => expect(values.failed?.()).toBe(true));
    daemon.restoreRequests();
    await vi.advanceTimersByTimeAsync(1000);
    expect(values.get()["threads.useWorktree"]).toBeDefined();
    expect(values.failed?.()).toBe(false);
  } finally {
    stop();
    vi.useRealTimers();
  }
});
