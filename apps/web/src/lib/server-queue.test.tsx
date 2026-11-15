import { ClientProvider } from "@ace/client-react";
import { FakeDaemon } from "@ace/fake-daemon";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";
import type { Client } from "@ace/client";
import { fakeClient } from "@/test/harness.tsx";
import { restoreQueries } from "./query-persistence.ts";
import { useServerQueue } from "./server-queue.ts";

/*
 * A queue page read back from disk shows at once, but nothing may act on it until the daemon
 * has answered a queue read: not when the thread's queue revision moves on before that answer
 * lands (the old page is shown meanwhile), and not when that answer fails.
 */

async function opened() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({ id: "queued", workspaceId: "project", provider: "codex", title: "Queued" });
  daemon.holdQueue("queued", "manual");
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const lease = client.thread("queued");
  await waitFor(() => expect(lease.store.queue).toBeDefined());
  const revision = lease.store.queue?.revision ?? 0;
  return { daemon, client, revision };
}

/** Queue reads wait for `answer`; each one fails when `fail` is set. */
function gateQueueReads(client: Client) {
  const request = client.request.bind(client);
  const gate = { open: Promise.withResolvers<void>(), fail: false };
  vi.spyOn(client, "request").mockImplementation(async (message, options) => {
    if (message.type === "queue.get") {
      await gate.open.promise;
      if (gate.fail) throw new Error("Queue read failed");
    }
    return request(message, options);
  });
  return gate;
}

function mount(client: Client, revision: number) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // What an earlier session kept: this thread's queue page at the revision it then had.
  restoreQueries(queries, [
    {
      key: ["queue", "queued", revision],
      data: { threadId: "queued", revision, messages: [], next: null },
      at: 1,
    },
  ]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client}>
      <QueryClientProvider client={queries}>{children}</QueryClientProvider>
    </ClientProvider>
  );
  return renderHook(() => useServerQueue("queued"), { wrapper });
}

test.each([
  ["still in flight", false],
  ["failed", true],
])(
  "a kept queue stays unconfirmed when the revision moves on and the new read is %s",
  async (_case, fail) => {
    const { daemon, client, revision } = await opened();
    const gate = gateQueueReads(client);
    gate.fail = fail;
    const view = mount(client, revision);
    expect(view.result.current.page?.revision).toBe(revision);
    expect(view.result.current.unconfirmed).toBe(true);
    // The thread's queue moves on before any queue read has answered.
    act(() => daemon.waitingSteer("queued", "m1", "hello", "fell_back"));
    await waitFor(() => expect(client.cachedThread("queued")?.queue?.revision).toBe(revision + 1));
    if (fail) gate.open.resolve();
    await act(async () => {
      await Promise.resolve();
    });
    // The page shown is still the kept one, and still unconfirmed.
    expect(view.result.current.page?.revision).toBe(revision);
    expect(view.result.current.unconfirmed).toBe(true);
  },
);

test("a kept queue is confirmed once the daemon answers the read it shows", async () => {
  const { daemon, client, revision } = await opened();
  const gate = gateQueueReads(client);
  const view = mount(client, revision);
  act(() => daemon.waitingSteer("queued", "m1", "hello", "fell_back"));
  await waitFor(() => expect(client.cachedThread("queued")?.queue?.revision).toBe(revision + 1));
  gate.open.resolve();
  await waitFor(() => expect(view.result.current.page?.revision).toBe(revision + 1));
  expect(view.result.current.unconfirmed).toBe(false);
});
