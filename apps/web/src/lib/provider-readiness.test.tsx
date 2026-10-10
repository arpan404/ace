import { ClientProvider } from "@ace/client-react";
import { FakeDaemon } from "@ace/fake-daemon";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { fakeClient } from "@/test/harness.tsx";
import { useProvidersWatch } from "./provider-readiness.ts";

function Totals() {
  useProvidersWatch();
  const history = useQuery({
    queryKey: ["usage", "history"],
    initialData: "Known historical cost",
    staleTime: Infinity,
    queryFn: async () => "Historical cost was reread",
  });
  return <p>{history.data}</p>;
}

test("committed quota pushes update account limits without invalidating historical usage", async () => {
  const daemon = new FakeDaemon({ clock: () => 10 });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const accounts = await client.request({ type: "accounts.list" });
  const account = accounts.accounts[0];
  if (!account) throw new Error("Missing fake account");
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ClientProvider client={client}>
      <QueryClientProvider client={queries}>
        <Totals />
      </QueryClientProvider>
    </ClientProvider>,
  );
  await act(async () => {
    for (let n = 1; n <= 10; n++)
      daemon.services.updateQuota(account.id, {
        ...account.quota,
        observedAt: account.quota.observedAt + n,
      });
    await client.request({ type: "accounts.list" });
  });
  expect(screen.getByText("Known historical cost")).toBeTruthy();
  expect(screen.queryByText("Historical cost was reread")).toBeNull();
  queries.clear();
});
