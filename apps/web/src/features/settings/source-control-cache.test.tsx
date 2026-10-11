import { ClientProvider } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import { FakeDaemon } from "@ace/fake-daemon";
import { ForgePrStatus, ThreadId } from "@ace/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { AppFrame } from "@/app.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useSourceControlCache } from "@/lib/source-control-cache.ts";
import { fakeClient, memoryKeyValue } from "@/test/harness.tsx";
import { SourceControlSettings } from "./source-control-page.tsx";

const repository = { forge: "github", host: "github.com", owner: "octo", name: "ace" } as const;
function seed(daemon: FakeDaemon, id: string, title: string) {
  daemon.seedServices({ pullRequests: { [id]: ForgePrStatus.parse({
    ref: { repository, number: 7 }, title, url: "https://github.com/octo/ace/pull/7",
    headSha: "a".repeat(40), state: "open", mergeability: "mergeable", ci: "success",
    checks: [], comments: [], reviewThreads: [], raw: {},
  }) } });
}
function PrTitle({ id }: { id: string }) {
  const result = useDaemonQuery({ queryKey: ["thread", "pr", id], staleTime: 60_000,
    read: async (client, signal) => {
      const reply = await client.request({ type: "workspace.request", operation: { op: "pr.status", threadId: ThreadId.parse(id) } }, { signal });
      return reply.result.kind === "pr" ? reply.result.status?.title : undefined;
    } });
  return <p>{result.data ?? "Reading PR"}</p>;
}
function Watch({ client }: { client: ClientApi }) { useSourceControlCache(client); return null; }

test("saving source control preferences and rescanning replace cached PR results only for the selected daemon", async () => {
  const own = new FakeDaemon({ clock: () => 1000 });
  const other = new FakeDaemon({ clock: () => 1000 });
  own.createThread({ id: "own-pr", workspaceId: "repo", title: "Own", provider: "codex" });
  other.createThread({ id: "other-pr", workspaceId: "repo", title: "Other", provider: "codex" });
  seed(own, "own-pr", "Account A's result");
  seed(other, "other-pr", "Other daemon's cached result");
  const client = fakeClient(own);
  const sibling = fakeClient(other);
  await client.start(); await sibling.start();
  await waitFor(() => { expect(client.state).toBe("ready"); expect(sibling.state).toBe("ready"); });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const storage = memoryKeyValue();
  const tree = (show: boolean) => <AppFrame environment={{ storage, root: document.documentElement }}>
    <QueryClientProvider client={queries}>
      <ClientProvider client={client}><Watch client={client} /><SourceControlSettings />{show && <PrTitle id="own-pr" />}</ClientProvider>
      <ClientProvider client={sibling}><PrTitle id="other-pr" /></ClientProvider>
    </QueryClientProvider>
  </AppFrame>;
  const view = render(tree(true));
  try {
    await screen.findByText("Account A's result");
    await screen.findByText("Other daemon's cached result");
    await screen.findByText(/GitHub API access verified as ada/);
    view.rerender(tree(false));
    act(() => { seed(own, "own-pr", "Account B's result"); seed(other, "other-pr", "Other daemon's newer result"); });
    await userEvent.clear(screen.getByRole("textbox", { name: "Expected account" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Expected account" }), "other");
    await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await screen.findByText(/gh auth switch --hostname github.com --user other/);
    view.rerender(tree(true));
    await screen.findByText("Account B's result");
    expect(screen.queryByText("Account A's result")).toBeNull();
    expect(screen.getByText("Other daemon's cached result")).toBeTruthy();
    expect(screen.queryByText("Other daemon's newer result")).toBeNull();
    act(() => seed(own, "own-pr", "Rescanned result"));
    await userEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await screen.findByText("Rescanned result");
    expect(screen.queryByText("Account B's result")).toBeNull();
  } finally { view.unmount(); queries.clear(); }
});
