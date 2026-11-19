import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";

/*
 * The `@` list's state around ace-files' path index: a cached "still building" answer must not
 * hide a failed refetch behind an endless loading state, and the wait itself is bounded.
 */

type Answer = { paths: string[]; ready: boolean };
const answers: (() => Promise<Answer>)[] = [];
const complete = vi.fn(() => {
  const answer = answers.shift();
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
const trigger = { kind: "mention", query: "socket", start: 0, end: 7 } as never;

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
  const { result } = renderHook(() => useSuggestions(thread, trigger, () => []), {
    wrapper: wrapperFor(queryClient()),
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
