import { ClientProvider } from "@ace/client-react";
import { FakeDaemon, ScenarioPlayer, failingSubagent } from "@ace/fake-daemon";
import { act, render, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";
import { disposePanelServices, panelServices } from "../services.ts";
import { requestTerminalEnd } from "./closing.ts";
import { TerminalClient } from "./terminal-client.tsx";

test("a restored terminal close survives failed panel loading and a consumer remount until services recover", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  const terminal = daemon.terminals.openNow({
    threadId: "thread-settings",
    cwd: "/project",
    cols: 80,
    rows: 24,
  });
  const other = daemon.terminals.openNow({
    threadId: "thread-settings",
    cwd: "/project",
    cols: 80,
    rows: 24,
  });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const chunk = Promise.withResolvers<never>();
  const loading = panelServices(client, () => chunk.promise);
  const view = render(
    <ClientProvider client={client}>
      <TerminalClient />
    </ClientProvider>,
  );
  act(() => {
    requestTerminalEnd({ threadId: "thread-settings", terminalId: terminal.id });
    requestTerminalEnd({ threadId: "thread-settings", terminalId: terminal.id });
  });
  await act(async () => {
    chunk.reject(new Error("Panel chunk unavailable"));
    await expect(loading).rejects.toThrow("Panel chunk unavailable");
  });
  expect(daemon.terminals.list("thread-settings").map((entry) => entry.id)).toEqual([
    terminal.id,
    other.id,
  ]);
  view.unmount();
  await act(async () => {
    await panelServices(client);
  });
  await waitFor(() =>
    expect(daemon.terminals.list("thread-settings").map((entry) => entry.id)).toEqual([other.id]),
  );
  expect(daemon.terminals.list("thread-settings")[0]?.exitCode).toBeNull();
  disposePanelServices(client);
});
