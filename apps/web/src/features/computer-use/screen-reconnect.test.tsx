import { ClientProvider } from "@ace/client-react";
import { FakeDaemon } from "@ace/fake-daemon";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { DaemonConnectionContext, fallback, type DaemonEndpoint } from "@/boot/connection.tsx";
import { fakeClient } from "@/test/fake-client.ts";
import { useScreenSession } from "./screen-session.ts";

function Surface({ label }: { label: string }) {
  const { snapshot, reconnect } = useScreenSession();
  return (
    <>
      <output aria-label={label}>{snapshot.closed ? "closed" : "opening"}</output>
      <button onClick={reconnect}>Retry {label}</button>
    </>
  );
}

test("screen failures wait for manual Retry or a main reconnect and stop after the last view leaves", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  let attempts = 0;
  const failures: (() => void)[] = [];
  const endpoint: DaemonEndpoint = {
    kind: "fake",
    access: { origin: "http://fake", fetch: daemon.access.fetch, token: async () => daemon.token },
    devices: () => {
      throw new Error("Unused devices");
    },
    screen: () => ({
      open(events) {
        attempts++;
        failures.push(() => events.close());
      },
      send() {},
      close() {},
    }),
  };
  const connection = { ...fallback, endpoint };
  const view = render(
    <ClientProvider client={client}>
      <DaemonConnectionContext.Provider value={connection}>
        <Surface label="settings" />
        <Surface label="indicator" />
      </DaemonConnectionContext.Provider>
    </ClientProvider>,
  );
  for (let n = 0; n < 100; n++)
    await act(async () => {
      failures.shift()?.();
    });
  expect(attempts).toBe(1);
  expect(screen.getByLabelText("settings").textContent).toBe("closed");
  fireEvent.click(screen.getByRole("button", { name: "Retry settings" }));
  expect(attempts).toBe(2);
  await act(async () => {
    failures.shift()?.();
  });
  daemon.refuseConnections(true);
  act(() => daemon.disconnectAll());
  await waitFor(() => expect(client.state).not.toBe("ready"));
  daemon.refuseConnections(false);
  act(() => client.reconnectNow());
  await waitFor(() => expect(client.state).toBe("ready"));
  await waitFor(() => expect(attempts).toBe(3));
  view.unmount();
  await act(async () => {
    for (const fail of failures.splice(0)) fail();
  });
  expect(attempts).toBe(3);
});
