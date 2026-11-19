import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

/*
 * The `@` list's state around ace-files' path index: a cached "still building" answer must not
 * hide a failed refetch behind an endless loading state, the wait itself is bounded, and each
 * query's wait belongs to that query.
 */

afterEach(() => {
  vi.useRealTimers();
  fallback = undefined;
});

type Answer = { paths: string[]; ready: boolean };
const answers: (() => Promise<Answer>)[] = [];
/** What `complete` answers when the test did not queue one, for polling that must keep going. */
let fallback: (() => Promise<Answer>) | undefined;
const complete = vi.fn(() => {
  const answer = answers.shift() ?? fallback;
  return answer ? answer() : Promise.reject(new Error("offline"));
});

vi.mock("../sources/index.ts", () => ({
  useThreadSources: () => ({
    context: { complete },
    commands: { watch: () => () => {} },
  }),
}));
vi.mock("@ace/client-react", () => ({
  useConnectionGeneration: () => 1,
  useConnectionState: () => "ready",
  useSidebarIndex: () => [],
}));
vi.mock("@/features/panels/index.ts", () => ({ useMentionTabs: () => [] }));

import { buildingWaitMs, indexStillBuilding, useSuggestions } from "./suggestions.tsx";

const thread = {
  id: "thread-1",
  title: "Thread",
  workspaceId: "ace",
  provider: "codex",
  instanceId: "instance",
  draft: undefined,
  retryDraftScope: undefined,
} as never;
const mentionTrigger = { kind: "mention" as const, query: "socket", start: 0, end: 7 };
const trigger = mentionTrigger as never;

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

test("a failed refetch shows Try again even while the cached answer says the index is building", async () => {
  answers.push(async () => ({ paths: [], ready: false }));
  answers.push(async () => {
    throw new Error("offline");
  });
  const client = queryClient();
  const { result } = renderHook(() => useSuggestions(thread, trigger, () => []), {
    wrapper: wrapperFor(client),
  });
  await waitFor(() => expect(result.current.state).toBe("loading"));
  await waitFor(() => expect(result.current.state).toBe("failed"), { timeout: 5_000 });
  if (result.current.state !== "failed") throw new Error("expected a failure");
  answers.push(async () => ({ paths: ["src/socket.ts"], ready: true }));
  result.current.retry();
  await waitFor(() =>
    expect(result.current).toMatchObject({ state: "ready", items: [{ path: "src/socket.ts" }] }),
  );
});

test("a building index stops loading once its wait runs out", () => {
  const arrived = 1_000;
  expect(indexStillBuilding({ ready: false }, arrived, arrived)).toBe(true);
  expect(indexStillBuilding({ ready: false }, arrived, arrived + buildingWaitMs - 1)).toBe(true);
  expect(indexStillBuilding({ ready: false }, arrived, arrived + buildingWaitMs)).toBe(false);
  expect(indexStillBuilding({ ready: true }, arrived, arrived)).toBe(false);
  expect(indexStillBuilding(undefined, arrived, arrived)).toBe(false);
});

/** One poll that answers still-building, settled, so the render after it sees the clock. */
async function pollBuilding(client: QueryClient, completeCalls: number) {
  const release = Promise.withResolvers<void>();
  answers.push(async () => {
    await release.promise;
    return { paths: [], ready: false };
  });
  await waitFor(() => expect(complete.mock.calls.length).toBeGreaterThan(completeCalls), {
    timeout: 2_000,
  });
  await waitFor(() => expect(client.isFetching()).toBeGreaterThan(0), { timeout: 2_000 });
  release.resolve();
  await waitFor(() => expect(client.isFetching()).toBe(0), { timeout: 2_000 });
}

test("a cached cold query starts its own wait instead of inheriting another's", async () => {
  // Only the wall clock is faked; React Query's polling still runs on real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = new Date("2026-01-01T00:00:00Z").getTime();
  vi.setSystemTime(start);
  fallback = async () => ({ paths: [], ready: false });
  const client = queryClient();
  const { result, rerender } = renderHook(
    ({ query }: { query: string }) =>
      useSuggestions(thread, { ...mentionTrigger, query }, () => []),
    { wrapper: wrapperFor(client), initialProps: { query: "a" } },
  );
  await waitFor(() => expect(result.current.state).toBe("loading"));
  // A poll means a's first answer arrived and started a's wait.
  await waitFor(() => expect(complete.mock.calls.length).toBeGreaterThan(1), { timeout: 2_000 });

  // Eleven seconds into a's wait, the person opens a different query whose cached answer is also
  // still building. b's wait begins when b first answers, not when a did.
  vi.setSystemTime(start + buildingWaitMs - 1_000);
  client.setQueryData(["thread", "mention", "thread-1", "b"], { paths: [], ready: false });
  rerender({ query: "b" });
  await waitFor(() => expect(result.current.state).toBe("loading"));

  // Past a's deadline, b is still waiting on its own first answer rather than a's.
  vi.setSystemTime(start + buildingWaitMs + 500);
  rerender({ query: "b" });
  await waitFor(() => expect(result.current.state).toBe("loading"));
});

test("Try again restarts the wait instead of inheriting the deadline it dismissed", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = new Date("2026-01-01T00:00:00Z").getTime();
  vi.setSystemTime(start);
  fallback = async () => ({ paths: [], ready: false });
  const client = queryClient();
  const { result } = renderHook(() => useSuggestions(thread, trigger, () => []), {
    wrapper: wrapperFor(client),
  });
  await waitFor(() => expect(result.current.state).toBe("loading"));

  // Eleven seconds in, one poll fails: Try again is offered while the cached answer still says
  // the index is building and its wait has not run out.
  vi.setSystemTime(start + buildingWaitMs - 1_000);
  answers.push(async () => {
    throw new Error("offline");
  });
  await waitFor(() => expect(result.current.state).toBe("failed"), { timeout: 2_000 });
  if (result.current.state !== "failed") throw new Error("expected a failure");

  // Try again starts the wait over, so the still-building answer that follows gets its own full
  // time instead of expiring on the deadline the person just dismissed.
  result.current.retry();
  await waitFor(() => expect(result.current.state).toBe("loading"));
  vi.setSystemTime(start + buildingWaitMs + 2_000);
  await pollBuilding(client, complete.mock.calls.length);
  expect(result.current.state).toBe("loading");
});
