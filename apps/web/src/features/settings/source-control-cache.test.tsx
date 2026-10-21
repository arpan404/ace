import { ClientProvider } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import { FakeDaemon } from "@ace/fake-daemon";
import { ForgePrStatus, ThreadId, WorkspaceId } from "@ace/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { AppFrame } from "@/app.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useSourceControlCache } from "@/lib/source-control-cache.ts";
import { fakeClient, memoryKeyValue } from "@/test/harness.tsx";
import { SourceControlSettings } from "./source-control-page.tsx";
import { readForge } from "@/lib/forge-read.ts";
import { detail } from "@/features/forge/pr-workspace.fixture.ts";

const repository = { forge: "github", host: "github.com", owner: "octo", name: "ace" } as const;
function seed(daemon: FakeDaemon, id: string, title: string) {
  daemon.seedServices({
    pullRequests: {
      [id]: ForgePrStatus.parse({
        ref: { repository, number: 7 },
        title,
        url: "https://github.com/octo/ace/pull/7",
        headSha: "a".repeat(40),
        state: "open",
        mergeability: "mergeable",
        ci: "success",
        checks: [],
        comments: [],
        reviewThreads: [],
        raw: {},
      }),
    },
  });
}
function PrTitle({ id }: { id: string }) {
  const result = useDaemonQuery({
    queryKey: ["thread", "pr", id],
    staleTime: 60_000,
    read: async (client, signal) => {
      const reply = await client.request(
        { type: "workspace.request", operation: { op: "pr.status", threadId: ThreadId.parse(id) } },
        { signal },
      );
      return reply.result.kind === "pr" ? reply.result.status?.title : undefined;
    },
  });
  return <p>{result.data ?? "Reading PR"}</p>;
}
const forgeRead = {
  op: "forge.pr.detail",
  workspaceId: WorkspaceId.parse("repo"),
  number: 7,
} as const;
function ForgeTitle() {
  const result = useDaemonQuery({
    queryKey: ["forge", "repo", undefined, "pr", 7],
    staleTime: 60_000,
    read: async (client, signal) => {
      const value = await readForge(client, forgeRead, signal);
      return value.resource === "prDetail" ? value.value.status.title : undefined;
    },
  });
  return <p>{result.data ?? "Reading PR panel"}</p>;
}
function Watch({ client }: { client: ClientApi }) {
  useSourceControlCache(client);
  return null;
}

test("saving source control preferences and rescanning replace cached PR results only for the selected daemon", async () => {
  const own = new FakeDaemon({ clock: () => 1000 });
  const other = new FakeDaemon({ clock: () => 1000 });
  own.createThread({ id: "own-pr", workspaceId: "repo", title: "Own", provider: "codex" });
  other.createThread({ id: "other-pr", workspaceId: "repo", title: "Other", provider: "codex" });
  seed(own, "own-pr", "Account A's result");
  seed(other, "other-pr", "Other daemon's cached result");
  const client = fakeClient(own);
  const sibling = fakeClient(other);
  await client.start();
  await sibling.start();
  await waitFor(() => {
    expect(client.state).toBe("ready");
    expect(sibling.state).toBe("ready");
  });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const storage = memoryKeyValue();
  // Settings rows read the location (deep-link flash), so the page renders inside a router.
  let show = true;
  const tree = () => (
    <AppFrame environment={{ storage, root: document.documentElement }}>
      <QueryClientProvider client={queries}>
        <ClientProvider client={client}>
          <Watch client={client} />
          <SourceControlSettings />
          {show && <PrTitle id="own-pr" />}
        </ClientProvider>
        <ClientProvider client={sibling}>
          <PrTitle id="other-pr" />
        </ClientProvider>
      </QueryClientProvider>
    </AppFrame>
  );
  const router = createRouter({
    routeTree: createRootRoute({ component: () => tree() }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const shown = async (next: boolean) => {
    show = next;
    await act(() => router.invalidate());
  };
  const view = render(<RouterProvider router={router} />);
  try {
    await screen.findByText("Account A's result");
    await screen.findByText("Other daemon's cached result");
    await screen.findByText(/GitHub API access verified as ada/);
    await shown(false);
    act(() => {
      seed(own, "own-pr", "Account B's result");
      seed(other, "other-pr", "Other daemon's newer result");
    });
    await userEvent.clear(screen.getByRole("textbox", { name: "Expected account" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Expected account" }), "other");
    await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await screen.findByText(/gh auth switch --hostname github.com --user other/);
    await shown(true);
    await screen.findByText("Account B's result");
    expect(screen.queryByText("Account A's result")).toBeNull();
    expect(screen.getByText("Other daemon's cached result")).toBeTruthy();
    expect(screen.queryByText("Other daemon's newer result")).toBeNull();
    act(() => seed(own, "own-pr", "Rescanned result"));
    await userEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await screen.findByText("Rescanned result");
    expect(screen.queryByText("Account B's result")).toBeNull();
  } finally {
    view.unmount();
    queries.clear();
  }
});

test("switching the expected GitHub account re-reads the PR panel instead of showing the old account's data", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const titled = (title: string) =>
    daemon.workspace.setForgeRead(forgeRead, {
      resource: "prDetail",
      value: { ...detail, status: { ...detail.status, title } },
    });
  titled("Seen as ada");
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const storage = memoryKeyValue();
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <AppFrame environment={{ storage, root: document.documentElement }}>
          <QueryClientProvider client={queries}>
            <ClientProvider client={client}>
              <Watch client={client} />
              <SourceControlSettings />
              <ForgeTitle />
            </ClientProvider>
          </QueryClientProvider>
        </AppFrame>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(<RouterProvider router={router} />);
  try {
    await screen.findByText("Seen as ada");
    await screen.findByText(/GitHub API access verified as ada/);
    act(() => titled("Seen as octo"));
    await userEvent.type(screen.getByRole("textbox", { name: "Expected account" }), "octo");
    await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(await screen.findByText("Seen as octo")).toBeTruthy();
    expect(screen.queryByText("Seen as ada")).toBeNull();
    // The page names both accounts, so the person knows which one to switch to.
    expect(await screen.findByText("Signed in as ada, expected octo")).toBeTruthy();
  } finally {
    view.unmount();
    queries.clear();
    await client.close();
  }
});

test("a kept PR read survives a reconnect with unchanged preferences, and is dropped when preferences change", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const titled = (title: string) =>
    daemon.workspace.setForgeRead(forgeRead, {
      resource: "prDetail",
      value: { ...detail, status: { ...detail.status, title } },
    });
  titled("Kept");
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const storage = memoryKeyValue();
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <AppFrame environment={{ storage, root: document.documentElement }}>
          <QueryClientProvider client={queries}>
            <ClientProvider client={client}>
              <Watch client={client} />
              <ForgeTitle />
            </ClientProvider>
          </QueryClientProvider>
        </AppFrame>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(<RouterProvider router={router} />);
  try {
    await screen.findByText("Kept");
    const held = daemon.workspace.holdForgeRead(forgeRead);
    daemon.refuseConnections(true);
    act(() => daemon.disconnectAll());
    await waitFor(() => expect(client.state).not.toBe("ready"));
    daemon.refuseConnections(false);
    act(() => client.reconnectNow());
    await waitFor(() => expect(client.state).toBe("ready"));
    await waitFor(() => expect(daemon.workspace.forgeReadCount(forgeRead)).toBeGreaterThan(1));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.getByText("Kept")).toBeTruthy();
    expect(screen.queryByText("Reading PR panel")).toBeNull();
    held();
    const changing = daemon.workspace.holdForgeRead(forgeRead);
    act(() => {
      titled("New");
      daemon.services.settings.write("sourceControl.preferences", {
        hosts: [{ host: "github.com", account: "other" }],
        host: "github.com",
        remote: "origin",
      });
    });
    await screen.findByText("Reading PR panel");
    changing();
    await screen.findByText("New");
    expect(screen.queryByText("Kept")).toBeNull();
  } finally {
    view.unmount();
    queries.clear();
    await client.close();
  }
});
