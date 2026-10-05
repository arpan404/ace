import { FakeDaemon, flakyCheckout, ScenarioPlayer } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { App, AppFrame } from "@/app.tsx";
import { ConnectionGate } from "@/app/connection-gate.tsx";
import { webStorage } from "@/boot/web-storage.ts";
import { fakeClient } from "@/test/harness.tsx";
import { BootFailure } from "./boot-failure.tsx";

const token = "ab".repeat(32);
const denied = () => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};

test("with site data blocked, ace still starts at the connect screen and can connect", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token });
  new ScenarioPlayer(daemon, flakyCheckout()).runThrough("explorer-spawned");
  // One browser throws on touching `localStorage`, another only once it is used.
  const local = webStorage(denied);
  const session = webStorage(() => ({ getItem: denied }) as unknown as Storage);
  render(
    <AppFrame environment={{ storage: local }}>
      <ConnectionGate
        stores={{ local, session }}
        defaultUrl="ws://127.0.0.1:4242/"
        createClient={(target) => fakeClient(daemon, target.token)}
      >
        {(client) => (
          <App client={client} history={createMemoryHistory({ initialEntries: ["/"] })} />
        )}
      </ConnectionGate>
    </AppFrame>,
  );
  await userEvent.type(await screen.findByLabelText("Token", { exact: true }), token);
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByRole("link", { name: /Fix flaky checkout test/ })).toBeTruthy();
});

test("when a provider itself throws, the window still says ace couldn't start", () => {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <AppFrame
      environment={{
        matchMedia: () => {
          throw new Error("matchMedia is not available here");
        },
      }}
    >
      <p>app</p>
    </AppFrame>,
  );
  expect(screen.getByRole("heading", { name: "ace couldn't start" })).toBeTruthy();
  expect(screen.getByText("matchMedia is not available here")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  expect(screen.queryByText("app")).toBeNull();
  quiet.mockRestore();
});

test("an error that carries a daemon token never shows it", () => {
  render(
    <AppFrame environment={{}}>
      <BootFailure error={new Error(`Rejected http://127.0.0.1:4242/#token=${token} (${token})`)} />
    </AppFrame>,
  );
  expect(document.body.textContent).not.toContain(token);
  expect(screen.getByText(/Rejected http:\/\/127\.0\.0\.1:4242\/#token=\[hidden\]/)).toBeTruthy();
});
