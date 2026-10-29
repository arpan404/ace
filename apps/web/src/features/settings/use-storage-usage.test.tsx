import { ClientProvider } from "@ace/client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { FakeDaemon } from "@ace/fake-daemon";
import { fakeClient } from "@/test/fake-client.ts";
import { storageUsageKey } from "@/lib/storage-usage-policy.ts";
import { useStorageUsage } from "./use-storage-usage.ts";

// A cleanup handler holds its refresh callback while its daemon operation is pending.
test("cleanup still forces a measurement when a cached read starts while cleanup is pending", async () => {
  const daemon = new FakeDaemon({ clock: () => 1_000 });
  const client = fakeClient(daemon);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const saved = {
    categories: [],
    databaseBytes: 2_000_000,
    reclaimableDatabaseBytes: 0,
    measuredAt: 1_000,
    complete: true,
    backups: [],
  };
  cache.setQueryData(storageUsageKey, saved);
  const gate = Promise.withResolvers<void>();
  const operations: unknown[] = [];
  const request = client.request.bind(client);
  vi.spyOn(client, "request").mockImplementation(async (input, options) => {
    if (input.type === "storage.request" && input.operation.op === "storage.usage") {
      operations.push(input.operation);
      if (operations.length === 1) await gate.promise;
    }
    return request(input, options);
  });
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const view = renderHook(useStorageUsage, {
    wrapper: ({ children }) => (
      <ClientProvider client={client}>
        <QueryClientProvider client={cache}>{children}</QueryClientProvider>
      </ClientProvider>
    ),
  });
  const cleanupRefresh = view.result.current.refresh;
  let normal: Promise<void>;
  act(() => {
    normal = cache.invalidateQueries({ queryKey: storageUsageKey });
  });
  await waitFor(() => expect(operations).toHaveLength(1));
  let refresh: Promise<unknown>;
  act(() => {
    refresh = cleanupRefresh();
  });
  gate.resolve();
  await act(async () => {
    await normal;
    await refresh;
  });
  expect(operations).toEqual([{ op: "storage.usage" }, { op: "storage.usage", force: true }]);
  view.unmount();
  cache.clear();
});

test("a refresh awaiting the old host never writes the newly selected host into its cache", async () => {
  const localDaemon = new FakeDaemon({ clock: () => 1_000 });
  const remoteDaemon = new FakeDaemon({ clock: () => 1_000 });
  localDaemon.seedServices({ storageDatabase: { bytes: 2_000_000, reclaimable: 0 } });
  remoteDaemon.seedServices({ storageDatabase: { bytes: 3_000_000, reclaimable: 0 } });
  const local = fakeClient(localDaemon);
  const remote = fakeClient(remoteDaemon);
  const localCache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const remoteCache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const gate = Promise.withResolvers<void>();
  const operations: unknown[] = [];
  const request = local.request.bind(local);
  vi.spyOn(local, "request").mockImplementation(async (input, options) => {
    if (input.type === "storage.request" && input.operation.op === "storage.usage") {
      operations.push(input.operation);
      if (operations.length === 1) await gate.promise;
    }
    return request(input, options);
  });
  await Promise.all([local.start(), remote.start()]);
  await waitFor(() => expect([local.state, remote.state]).toEqual(["ready", "ready"]));
  const view = renderHook(useStorageUsage, {
    wrapper: ({ children }) => (
      <ClientProvider client={local}>
        <QueryClientProvider client={localCache}>{children}</QueryClientProvider>
      </ClientProvider>
    ),
  });
  await waitFor(() => expect(operations).toHaveLength(1));
  let first: Promise<unknown>;
  let second: Promise<unknown>;
  act(() => {
    first = view.result.current.refresh();
    second = view.result.current.refresh();
  });
  // Settings keys MachineScope by host, so selecting another host remounts the page.
  view.unmount();
  const switched = renderHook(useStorageUsage, {
    wrapper: ({ children }) => (
      <ClientProvider client={remote}>
        <QueryClientProvider client={remoteCache}>{children}</QueryClientProvider>
      </ClientProvider>
    ),
  });
  await waitFor(() => expect(switched.result.current.query.data?.databaseBytes).toBe(3_000_000));
  gate.resolve();
  await act(async () => {
    await Promise.all([first, second]);
  });
  expect(operations).toEqual([{ op: "storage.usage" }, { op: "storage.usage", force: true }]);
  expect(localCache.getQueryData(storageUsageKey)).toMatchObject({ databaseBytes: 2_000_000 });
  expect(remoteCache.getQueryData(storageUsageKey)).toMatchObject({ databaseBytes: 3_000_000 });
  expect(switched.result.current.query.data?.databaseBytes).toBe(3_000_000);
  switched.unmount();
  localCache.clear();
  remoteCache.clear();
});
