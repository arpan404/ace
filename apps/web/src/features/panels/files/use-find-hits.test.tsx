import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useFindHits } from "./use-find-hits.ts";
import { FindBar } from "./find-bar.tsx";

// Worker dispatch is the uncontrollable boundary. Hold its cache probe while the real hook
// changes query and releases its queue lease, then observe whether the full source is sent.
const worker = vi.hoisted(() => ({
  requests: [] as {
    input: { hash: string; query: string; text?: string };
    resolve(output: { line: number; column: number }[] | null): void;
    reject(error: Error): void;
  }[],
}));
vi.mock("@/lib/off-thread.ts", () => ({
  offThread: () => ({
    parallel: true,
    run: (input: { hash: string; query: string; text?: string }) =>
      new Promise<{ line: number; column: number }[] | null>((resolve, reject) => {
        worker.requests.push({ input, resolve, reject });
      }),
  }),
}));

afterEach(async () => {
  await act(async () => {
    for (const request of worker.requests.splice(0)) request.resolve(null);
  });
});

test("a query canceled during its cache probe never sends the whole source to the worker", async () => {
  const source = "Search for alpha or beta in this source.";
  const view = renderHook(({ query }) => useFindHits(source, query), {
    initialProps: { query: "alpha" },
  });
  await waitFor(() => expect(worker.requests).toHaveLength(1));
  view.rerender({ query: "beta" });
  await act(async () => worker.requests[0]?.resolve(null));
  await waitFor(() => expect(worker.requests).toHaveLength(2));
  expect(worker.requests[1]?.input).toMatchObject({ query: "beta" });
  expect(
    worker.requests.some((request) => request.input.query === "alpha" && request.input.text),
  ).toBe(false);
  await act(async () => worker.requests[1]?.resolve([{ line: 0, column: 20 }]));
  await waitFor(() =>
    expect(view.result.current).toMatchObject({ status: "ready", hits: [{ line: 0, column: 20 }] }),
  );
  view.unmount();
});

test("a failed worker search stays distinct from no matches and retries the unchanged query", async () => {
  const view = renderHook(() => useFindHits("alpha beta", "beta"));
  expect(view.result.current).toMatchObject({ status: "pending", hits: [] });
  await waitFor(() => expect(worker.requests).toHaveLength(1));
  await act(async () => worker.requests[0]?.reject(new Error("Worker failed")));
  await waitFor(() => expect(view.result.current).toMatchObject({ status: "failed", hits: [] }));
  act(() => view.result.current.retry());
  expect(view.result.current).toMatchObject({ status: "pending", hits: [] });
  await waitFor(() => expect(worker.requests).toHaveLength(2));
  await act(async () => worker.requests[1]?.resolve(null));
  await waitFor(() => expect(worker.requests).toHaveLength(3));
  await act(async () => worker.requests[2]?.resolve([{ line: 0, column: 6 }]));
  await waitFor(() =>
    expect(view.result.current).toMatchObject({ status: "ready", hits: [{ line: 0, column: 6 }] }),
  );
  view.unmount();
});

test("a rejected search can retry after other file searches free the shared admission budget", async () => {
  const source = "x".repeat(4 * 1024 * 1024);
  const first = renderHook(() => useFindHits(source, "first"));
  const second = renderHook(() => useFindHits(source, "second"));
  const view = renderHook(() => useFindHits("alpha beta", "beta"));
  await waitFor(() => expect(worker.requests).toHaveLength(1));
  await waitFor(() => expect(view.result.current).toMatchObject({ status: "failed", hits: [] }));
  first.unmount();
  second.unmount();
  await act(async () => worker.requests[0]?.resolve(null));
  act(() => view.result.current.retry());
  await waitFor(() => expect(worker.requests).toHaveLength(2));
  await act(async () => worker.requests[1]?.resolve([{ line: 0, column: 6 }]));
  await waitFor(() => expect(view.result.current).toMatchObject({ status: "ready" }));
  view.unmount();
});

function Search() {
  const search = useFindHits("alpha beta", "beta");
  return (
    <FindBar
      query="beta"
      count={search.hits.length}
      index={0}
      status={search.status}
      onRetry={search.retry}
      onQuery={() => {}}
      onStep={() => {}}
      onClose={() => {}}
    />
  );
}

test("find offers retry after a worker error and enables match navigation when recovery finishes", async () => {
  const view = render(<Search />);
  expect(screen.getByText("Searching...")).toBeDefined();
  expect(screen.queryByText("No results")).toBeNull();
  await waitFor(() => expect(worker.requests).toHaveLength(1));
  await act(async () => worker.requests[0]?.reject(new Error("Worker failed")));
  expect(await screen.findByText("Search unavailable")).toBeDefined();
  expect(screen.queryByText("No results")).toBeNull();
  expect(screen.getByRole("button", { name: "Next match" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry search" }));
  expect(screen.getByText("Searching...")).toBeDefined();
  await waitFor(() => expect(worker.requests).toHaveLength(2));
  await act(async () => worker.requests[1]?.resolve([{ line: 0, column: 6 }]));
  expect(await screen.findByText("1 of 1")).toBeDefined();
  expect(screen.getByRole("button", { name: "Next match" }).hasAttribute("disabled")).toBe(false);
  expect(screen.queryByRole("button", { name: "Retry search" })).toBeNull();
  view.unmount();
});

test("no results is shown only after a successful empty search", async () => {
  const view = render(<Search />);
  expect(screen.queryByText("No results")).toBeNull();
  await waitFor(() => expect(worker.requests).toHaveLength(1));
  await act(async () => worker.requests[0]?.resolve([]));
  expect(await screen.findByText("No results")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Retry search" })).toBeNull();
  view.unmount();
});
