import { AccessClient } from "@ace/client/access";
import { FakeDaemon } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AppFrame } from "@/app.tsx";
import { ConnectionGate } from "@/app/connection-gate.tsx";
import { loadTarget, saveTarget, type ConnectionStores } from "@/boot/connection-settings.ts";
import { fakeAccountBackend, fakeOrigin } from "@/boot/fake-account.ts";
import { AceAccountBackendContext } from "@/features/ace-account/index.ts";
import { fakeClient, memoryKeyValue } from "@/test/harness.tsx";
import { NoMachineApp } from "./index.ts";

afterEach(() => vi.unstubAllGlobals());

const url = "ws://127.0.0.1:4242/";

/** A window as the browser entry builds it: the gate, with the app for no machine. */
function openWindow(options: {
  daemon: FakeDaemon;
  stores: ConnectionStores;
  desktop?: boolean;
  signedIn?: boolean;
  at?: string;
  /** The token the window's client sends; the daemon's own by default. */
  token?: string;
}) {
  const session = memoryKeyValue();
  // One history for the window, as a browser has: the app with no machine may mount again.
  const history = createMemoryHistory({ initialEntries: [options.at ?? "/"] });
  const backend = () => {
    const made = fakeAccountBackend(session, Date.now);
    if (!options.signedIn) session.removeItem(`ace.account.session:${fakeOrigin}`);
    return made;
  };
  return render(
    <AppFrame environment={{}}>
      <AceAccountBackendContext value={backend}>
        <ConnectionGate
          stores={options.stores}
          defaultUrl={url}
          desktop={options.desktop ?? false}
          createClient={() => fakeClient(options.daemon, options.token ?? options.daemon.token)}
          noMachine={() => (
            <NoMachineApp
              storage={options.stores.local}
              windowStorage={options.stores.session}
              history={history}
            />
          )}
        >
          {(_client, connection) => <p>Working on {connection.hostId}</p>}
        </ConnectionGate>
      </AceAccountBackendContext>
    </AppFrame>,
  );
}

const stores = (): ConnectionStores & { local: ReturnType<typeof memoryKeyValue> } => ({
  local: memoryKeyValue(),
  session: memoryKeyValue(),
});

const noConnectScreen = () =>
  expect(screen.queryByRole("heading", { name: "Connect to ace" })).toBeNull();

test("a fresh window opens the app, not the connect screen, and Profile offers Sign in", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  openWindow({ daemon, stores: stores() });
  expect(await screen.findByText("Threads run on a machine. Add one to start.")).toBeTruthy();
  noConnectScreen();
  await userEvent.click(screen.getByRole("link", { name: "Profile" }));
  const signIn = await screen.findByRole("button", { name: "Sign in" });
  expect(signIn.hasAttribute("disabled")).toBe(false);
  // This computer's numbers need a machine.
  expect(screen.queryByRole("region", { name: "Activity" })).toBeNull();
});

test("signed in with no machine, Profile shows the account and Sign out", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  openWindow({ daemon, stores: stores(), signedIn: true, at: "/settings/profile" });
  expect(await screen.findByRole("button", { name: "Sign out" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
});

test("signed in with no machine, Fleet lists the machines on the ace account", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  openWindow({ daemon, stores: stores(), signedIn: true, at: "/settings/remote" });
  expect(await screen.findByText("Studio")).toBeTruthy();
  expect(screen.getByText("Travel laptop")).toBeTruthy();
});

test("pairing from inside the app makes it this window's machine, and a reload keeps it", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000, token: "a".repeat(64) });
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => daemon.access.fetch(input, init));
  const access = new AccessClient({
    origin: "http://127.0.0.1:4242/",
    fetch: daemon.access.fetch,
    token: async () => daemon.access.token,
  });
  const pairing = await access.pairing(["read", "projects"]);
  const window = stores();
  const first = openWindow({ daemon, stores: window });

  await userEvent.click(await screen.findByRole("link", { name: "Add a machine" }));
  await userEvent.click(await screen.findByRole("button", { name: "Pair a machine" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(within(dialog).getByLabelText("Pairing link or code"), pairing.url);
  await userEvent.type(within(dialog).getByRole("textbox", { name: "This device's name" }), "Lab");
  await userEvent.click(within(dialog).getByRole("button", { name: "Pair and connect" }));
  expect(await screen.findByText(`Working on ${daemon.hostId}`)).toBeTruthy();
  expect(loadTarget(window).target?.pairedDeviceId).toBeTruthy();

  first.unmount();
  openWindow({ daemon, stores: window });
  expect(await screen.findByText(`Working on ${daemon.hostId}`)).toBeTruthy();
  expect(screen.queryByText("Threads run on a machine. Add one to start.")).toBeNull();
});

test("connecting by address that fails can go back to the app with no machine", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  daemon.refuseConnections(true);
  openWindow({ daemon, stores: stores(), at: "/settings/remote" });
  await userEvent.click(await screen.findByRole("button", { name: "Connect by address" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(within(dialog).getByLabelText("Token"), daemon.token);
  await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't reach/);
  await userEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(await screen.findByText("Threads run on a machine. Add one to start.")).toBeTruthy();
});

test("a stored machine still opens straight into its app", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  const window = stores();
  saveTarget(window, { url, token: daemon.token }, true);
  openWindow({ daemon, stores: window });
  expect(await screen.findByText(`Working on ${daemon.hostId}`)).toBeTruthy();
  expect(screen.queryByText("Threads run on a machine. Add one to start.")).toBeNull();
  noConnectScreen();
});

test("a desktop with no daemon of its own opens the app with no machine", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  openWindow({ daemon, stores: stores(), desktop: true });
  expect(await screen.findByText("Threads run on a machine. Add one to start.")).toBeTruthy();
  noConnectScreen();
});

test("the pairing address with no machine opens Fleet on the pairing form", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  openWindow({ daemon, stores: stores(), at: "/pair" });
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("form", { name: "Pair this device" })).toBeTruthy();
});

test("a stored machine that refuses this window says so on the connect screen, not an empty app", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  const window = stores();
  saveTarget(window, { url, token: daemon.token }, true);
  openWindow({ daemon, stores: window, token: "c".repeat(64) });
  expect((await screen.findByRole("alert")).textContent).toContain("didn't accept");
  expect(screen.getByRole("heading", { name: "Connect to ace" })).toBeTruthy();
  expect(screen.queryByText("Threads run on a machine. Add one to start.")).toBeNull();
});
