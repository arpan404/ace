import { Client, type ClientApi } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { memoryStorage } from "@/boot/client.ts";
import { useDaemonQuery } from "./daemon-query.ts";

function Projects({
  label,
  forever = false,
  enabled = true,
}: {
  label: string;
  forever?: boolean;
  enabled?: boolean;
}) {
  const query = useDaemonQuery({
    queryKey: ["projects", !enabled ? "disabled" : forever ? "forever" : "fresh"],
    staleTime: forever ? Infinity : 60_000,
    enabled,
    read: async (client: ClientApi, signal) => {
      const response = await client.request(
        { type: "workspace.request", operation: { op: "workspaces.list", limit: 100 } },
        { signal },
      );
      if (response.result.kind !== "workspaces") throw new Error("Missing projects");
      return response.result.workspaces.map((project) => project.name).join(", ");
    },
  });
  return <output aria-label={label}>{query.data ?? "unread"}</output>;
}

test("a short reconnect refreshes shared fresh and Infinity daemon reads while disabled reads stay idle", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/site" }]);
  let ids = 0;
  const retry = new Set<() => void>();
  const client = new Client({
    deviceId: DeviceId.parse("query-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: memoryStorage(),
    id: () => `query-${++ids}`,
    random: () => 0.5,
    scheduler: {
      set(_delay, callback) {
        retry.add(callback);
        return () => retry.delete(callback);
      },
    },
  });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await client.start();
    await waitFor(() => expect(client.state).toBe("ready"));
    await client.projects.add({ path: "/home/dev/site" });
    let reads = 0;
    client.onMessage((message) => {
      if (message.type === "workspace.result" && message.result.kind === "workspaces") reads++;
    });
    const view = render(
      <ClientProvider client={client}>
        <QueryClientProvider client={cache}>
          <Projects label="first" />
          <Projects label="second" />
          <Projects label="forever" forever />
          <Projects label="disabled" forever enabled={false} />
        </QueryClientProvider>
      </ClientProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("first").textContent).toBe("site"));
    await waitFor(() => expect(screen.getByLabelText("forever").textContent).toBe("site"));
    expect(reads).toBe(2);
    // No project push reaches this client during the outage.
    act(() => {
      daemon.refuseConnections(true);
      daemon.disconnectAll();
    });
    await waitFor(() => expect(client.state).not.toBe("ready"));
    const workspace = daemon.projects.list().workspaces[0];
    if (!workspace) throw new Error("Missing fixture project");
    daemon.projects.command({
      type: "workspace.rename",
      workspaceId: workspace.id,
      name: "Renamed site",
    });
    daemon.refuseConnections(false);
    await act(async () => {
      // Only reconnect callbacks are pending: both initial reads already completed.
      for (const callback of retry) callback();
    });
    await waitFor(() => expect(client.state).toBe("ready"));
    await waitFor(() => expect(screen.getByLabelText("first").textContent).toBe("Renamed site"));
    expect(screen.getByLabelText("second").textContent).toBe("Renamed site");
    await waitFor(() => expect(screen.getByLabelText("forever").textContent).toBe("Renamed site"));
    expect(reads).toBe(4);
    expect(screen.getByLabelText("disabled").textContent).toBe("unread");
    view.unmount();
  } finally {
    cache.clear();
    await client.close();
  }
});
