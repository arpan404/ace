import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useFindHits } from "./use-find-hits.ts";

// Worker dispatch is the uncontrollable boundary. Hold its cache probe while the real hook
// changes query and releases its queue lease, then observe whether the full source is sent.
const worker = vi.hoisted(() => ({
  requests: [] as {
    input: { hash: string; query: string; text?: string };
    resolve(output: { line: number; column: number }[] | null): void;
  }[],
}));
vi.mock("@/lib/off-thread.ts", () => ({
  offThread: () => ({
    parallel: true,
    run: (input: { hash: string; query: string; text?: string }) =>
      new Promise<{ line: number; column: number }[] | null>((resolve) => {
        worker.requests.push({ input, resolve });
      }),
  }),
}));

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
  await waitFor(() => expect(view.result.current).toEqual([{ line: 0, column: 20 }]));
  view.unmount();
});
