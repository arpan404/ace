import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClientProvider } from "@ace/client-react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { AppFrame, createQueryClient } from "@/app.tsx";
import { LayoutProvider } from "@/lib/layout.tsx";
import { harness } from "@/test/harness.tsx";
import { QueryState } from "./query-state.tsx";
import { PrMoreFiles } from "./pr-more-files.tsx";

function Unanswered() {
  const query = useQuery({ queryKey: ["unanswered"], queryFn: () => new Promise<never>(() => {}) });
  return <QueryState label="commits" query={query} />;
}

test("a first read says what is loading until it answers", async () => {
  const app = harness();
  await app.client.start();
  render(
    <AppFrame environment={{ storage: app.storage, root: document.documentElement }}>
      <ClientProvider client={app.client}>
        <QueryClientProvider client={createQueryClient()}>
          <LayoutProvider storage={app.storage}>
            <Unanswered />
          </LayoutProvider>
        </QueryClientProvider>
      </ClientProvider>
    </AppFrame>,
  );
  expect(
    await screen.findByRole("status", { name: "Loading commits" }, { timeout: 10_000 }),
  ).toBeTruthy();
});

test("the next page of files says it is loading, and a failed one offers Retry", () => {
  const props = { loaded: 1, root: { current: null }, onMore: () => {}, onRetry: () => {} };
  const { rerender } = render(<PrMoreFiles state="loading" {...props} />);
  expect(screen.getByRole("status", { name: "Loading more files" })).toBeTruthy();
  rerender(<PrMoreFiles state="failed" {...props} />);
  expect(screen.queryByRole("status", { name: "Loading more files" })).toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});
