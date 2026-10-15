import { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { memoryStorage } from "@/boot/client.ts";
import { useRegisteredProjects } from "./projects.ts";

function Count() {
  const { ids, loaded } = useRegisteredProjects();
  return <output aria-label="projects">{loaded ? ids.length : "unread"}</output>;
}

test("all 1200 projects are listed, past the daemon's hundred-per-page reads", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const folders = Array.from({ length: 1200 }, (_, index) => ({ path: `/home/dev/p${index}` }));
  daemon.projects.seedFolders("/home/dev", folders);
  for (const folder of folders)
    daemon.projects.command({ type: "workspace.add", path: folder.path });
  let ids = 0;
  const client = new Client({
    deviceId: DeviceId.parse("projects-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: memoryStorage(),
    id: () => `projects-${++ids}`,
    random: () => 0.5,
    scheduler: { set: () => () => {} },
  });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await client.start();
    await waitFor(() => expect(client.state).toBe("ready"));
    render(
      <ClientProvider client={client}>
        <QueryClientProvider client={cache}>
          <Count />
        </QueryClientProvider>
      </ClientProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("projects").textContent).toBe("1200"), {
      timeout: 10_000,
    });
  } finally {
    cache.clear();
    await client.close();
  }
});
