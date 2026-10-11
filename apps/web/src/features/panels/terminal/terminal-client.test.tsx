import { ClientProvider } from "@ace/client-react";
import { FakeDaemon, ScenarioPlayer, failingSubagent } from "@ace/fake-daemon";
import { act, render, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { createMemoryHistory } from "@tanstack/react-router";
import { App, AppFrame } from "@/app.tsx";
import { bindTerminalEndDelivery } from "./end-delivery.ts";
import { fakeClient } from "@/test/fake-client.ts";
import { disposePanelServices, panelServices } from "../services.ts";
import { requestTerminalEnd } from "./closing.ts";
import { TerminalClient } from "./terminal-client.tsx";

function shells(daemon: FakeDaemon) {
  return ["first", "second"].map((name) =>
    daemon.terminals.openNow({
      threadId: "thread-settings",
      cwd: "/project",
      cols: 80,
      rows: 24,
      name,
    }),
  );
}

function workspace(client: ReturnType<typeof fakeClient>, key: string) {
  return (
    <AppFrame environment={{}}>
      <App key={key} client={client} history={createMemoryHistory({ initialEntries: ["/"] })} />
      <ClientProvider client={client}>
        <TerminalClient />
      </ClientProvider>
    </AppFrame>
  );
}

test("distinct restored closes survive repeated chunk failures and App retirement, and only resume on their daemon", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000, hostId: "close-owner" });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  const terminals = shells(daemon);
  const client = fakeClient(daemon);
  const owner = bindTerminalEndDelivery(client);
  await client.start();
  await owner.identified;
  const view = render(workspace(client, "first"));
  act(() => client.networkOnline(false));
  for (let attempt = 0; attempt < 2; attempt++) {
    const chunk = Promise.withResolvers<never>();
    const loading = panelServices(client, () => chunk.promise);
    act(() => {
      for (const terminal of terminals)
        requestTerminalEnd({ threadId: "thread-settings", terminalId: terminal.id });
    });
    await act(async () => {
      chunk.reject(new Error("Panel chunk unavailable"));
      await expect(loading).rejects.toThrow("Panel chunk unavailable");
    });
  }
  expect(daemon.terminals.list("thread-settings")).toHaveLength(2);
  // A pending load belongs to the old App, but closes belong to the authenticated daemon.
  const lateChunk = Promise.withResolvers<never>();
  const lateLoad = panelServices(client, () => lateChunk.promise);
  const foreign = new FakeDaemon({ clock: () => 1000, hostId: "other-close-owner" });
  new ScenarioPlayer(foreign, failingSubagent()).step();
  const foreignShells = shells(foreign);
  expect(foreignShells.map((entry) => entry.id)).toEqual(terminals.map((entry) => entry.id));
  const other = fakeClient(foreign);
  const otherOwner = bindTerminalEndDelivery(other);
  await other.start();
  await otherOwner.identified;
  view.rerender(workspace(other, "other"));
  owner.release();
  await client.close();
  await act(async () => {
    lateChunk.reject(new Error("Retired chunk unavailable"));
    await expect(lateLoad).rejects.toThrow("Retired chunk unavailable");
  });
  await act(async () => {
    await other.request({ type: "host.identity" });
  });
  expect(foreign.terminals.list("thread-settings")).toHaveLength(2);
  expect(daemon.terminals.list("thread-settings")).toHaveLength(2);
  const replacement = fakeClient(daemon);
  const replacementOwner = bindTerminalEndDelivery(replacement);
  await replacement.start();
  await replacementOwner.identified;
  view.rerender(workspace(replacement, "replacement"));
  await waitFor(() => expect(daemon.terminals.list("thread-settings")).toEqual([]));
  expect(foreign.terminals.list("thread-settings")).toHaveLength(2);
  view.unmount();
  otherOwner.release();
  replacementOwner.release();
  disposePanelServices(other);
});

test("closing a restored tab ends its shell even while the optional panel chunk is unavailable", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000, hostId: "close-without-chunk" });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  const [terminal, other] = shells(daemon);
  if (!terminal || !other) throw new Error("Missing fixture shells");
  const client = fakeClient(daemon);
  const owner = bindTerminalEndDelivery(client);
  await client.start();
  await owner.identified;
  const chunk = Promise.withResolvers<never>();
  const loading = panelServices(client, () => chunk.promise);
  const view = render(
    <AppFrame environment={{}}>
      <ClientProvider client={client}>
        <TerminalClient />
      </ClientProvider>
    </AppFrame>,
  );
  act(() => {
    requestTerminalEnd({ threadId: "thread-settings", terminalId: terminal.id });
    requestTerminalEnd({ threadId: "thread-settings", terminalId: terminal.id });
  });
  await waitFor(() =>
    expect(daemon.terminals.list("thread-settings").map((entry) => entry.id)).toEqual([other.id]),
  );
  await act(async () => {
    chunk.reject(new Error("Panel chunk unavailable"));
    await expect(loading).rejects.toThrow("Panel chunk unavailable");
  });
  view.unmount();
  owner.release();
  disposePanelServices(client);
});
