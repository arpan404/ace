import { FakeDaemon } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { AppFrame } from "@/app.tsx";
import { ConnectionGate } from "@/app/connection-gate.tsx";
import { saveAccountChoice, type ConnectionStores } from "@/boot/connection-settings.ts";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { fakeAccountBackend, fakeHostIds, fakeOrigin } from "@/boot/fake-account.ts";
import { fakeAccountRoutes } from "@/boot/fake-account-main.ts";
import { AceAccountBackendContext } from "@/features/ace-account/index.ts";
import { machineCodeGate } from "@ace/client";
import { createBrowserClient, memoryStorage } from "@/boot/client.ts";
import type { AccountRouteSource } from "@/boot/main-machine.ts";
import { fakeClient, memoryKeyValue } from "@/test/harness.tsx";
import { NoMachineApp } from "./index.ts";

const url = "ws://127.0.0.1:4242/";
const laptop = { origin: fakeOrigin, hostId: fakeHostIds.laptop, name: "Travel laptop" };

/** The machine's app, as far as these tests look: who it is and how this window reaches it. */
function MachineApp(props: { hostId: string }) {
  const connection = useDaemonConnection();
  return (
    <p>
      Working on {props.hostId} via {connection.endpoint?.kind}
    </p>
  );
}

/** A window as the browser entry builds it, with machines on the fake ace account. */
function openWindow(options: {
  daemon: FakeDaemon;
  stores: ConnectionStores;
  session: ReturnType<typeof memoryKeyValue>;
  signedIn?: boolean;
  at?: string;
  removed?: ReadonlySet<string>;
  routes?: AccountRouteSource;
  /** When the gate's deadlines run; real timers by default. */
  schedule?: (delayMs: number, run: () => void) => () => void;
}) {
  const routes =
    options.routes ??
    fakeAccountRoutes({
      daemon: options.daemon,
      session: options.session,
      now: Date.now,
      removed: options.removed,
    });
  // A signed-in window already holds its ace session when the gate starts.
  if (options.signedIn) fakeAccountBackend(options.session, Date.now);
  const backend = () => {
    const made = fakeAccountBackend(options.session, Date.now);
    if (!options.signedIn) options.session.removeItem(`ace.account.session:${fakeOrigin}`);
    return made;
  };
  return render(
    <AppFrame environment={{}}>
      <AceAccountBackendContext value={backend}>
        <ConnectionGate
          stores={options.stores}
          defaultUrl={url}
          createClient={() => fakeClient(options.daemon)}
          accountRoutes={routes}
          {...(options.schedule ? { schedule: options.schedule } : {})}
          noMachine={(place) => (
            <NoMachineApp
              storage={options.stores.local}
              windowStorage={options.stores.session}
              history={createMemoryHistory({ initialEntries: [place ?? options.at ?? "/"] })}
            />
          )}
        >
          {(_client, connection) => <MachineApp hostId={connection.hostId} />}
        </ConnectionGate>
      </AceAccountBackendContext>
    </AppFrame>,
  );
}

function windowStores() {
  return { local: memoryKeyValue(), session: memoryKeyValue() };
}

/** Fleet's row for a machine on the account, and its Open. */
async function openFromFleet(name: string) {
  const row = (await screen.findByText(name)).closest("[data-account-machine]");
  if (!(row instanceof HTMLElement)) throw new Error(`No account row for ${name}`);
  await userEvent.click(within(row).getByRole("button", { name: "Open" }));
}

test("opening an account machine from the app with no machine makes it this window's machine", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  const session = memoryKeyValue();
  openWindow({ daemon, stores: windowStores(), session, signedIn: true, at: "/settings/remote" });
  await openFromFleet("Travel laptop");
  expect(await screen.findByText(`Working on ${daemon.hostId} via account`)).toBeTruthy();
  expect(screen.queryByText("Threads run on a machine. Add one to start.")).toBeNull();
});

test("a reload opens the account machine again through the relay, keeping no grant or token", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  const session = memoryKeyValue();
  const stores = windowStores();
  const first = openWindow({ daemon, stores, session, signedIn: true, at: "/settings/remote" });
  await openFromFleet("Travel laptop");
  expect(await screen.findByText(`Working on ${daemon.hostId} via account`)).toBeTruthy();

  first.unmount();
  openWindow({ daemon, stores, session, signedIn: true });
  expect(await screen.findByText(`Working on ${daemon.hostId} via account`)).toBeTruthy();
  const kept = JSON.stringify([...stores.local.data, ...stores.session.data]);
  expect(kept).toContain(fakeHostIds.laptop);
  expect(kept).not.toContain("fake-grant");
  expect(kept).not.toContain(daemon.token);
});

test("signed out, a stored account machine says to sign in, and Sign in opens Profile", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  const stores = windowStores();
  saveAccountChoice(stores, laptop);
  openWindow({ daemon, stores, session: memoryKeyValue() });
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Sign in to your ace account to open Travel laptop.",
  );
  expect(screen.queryByText(/Working on/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Profile" })).toBeTruthy();
});

test("a machine that left the account says so, and Choose another machine opens Fleet", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  const session = memoryKeyValue();
  const stores = windowStores();
  saveAccountChoice(stores, laptop);
  openWindow({ daemon, stores, session, signedIn: true, removed: new Set([fakeHostIds.laptop]) });
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Travel laptop isn't on your ace account any more, or it turned this device away.",
  );
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Choose another machine" }));
  expect(await screen.findByRole("button", { name: "Pair a machine" })).toBeTruthy();
});

test("a machine that wants its code asks for it on the connection screen, then opens", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  const session = memoryKeyValue();
  openWindow({ daemon, stores: windowStores(), session, signedIn: true, at: "/settings/remote" });
  await openFromFleet("Studio");
  expect(await screen.findByText("Enter Studio's machine code to open it.")).toBeTruthy();

  await userEvent.type(screen.getByLabelText("Machine code"), "1111");
  await userEvent.click(screen.getByRole("button", { name: "Unlock" }));
  expect(await screen.findByText("That code didn't match. Try again.")).toBeTruthy();

  await userEvent.type(screen.getByLabelText("Machine code"), "2468");
  await userEvent.click(screen.getByRole("button", { name: "Unlock" }));
  expect(await screen.findByText(`Working on ${daemon.hostId} via account`)).toBeTruthy();
});

test("five wrong codes lock code entry for 15 minutes", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  const session = memoryKeyValue();
  const stores = windowStores();
  saveAccountChoice(stores, { origin: fakeOrigin, hostId: fakeHostIds.studio, name: "Studio" });
  openWindow({ daemon, stores, session, signedIn: true });
  for (let wrong = 0; wrong < 5; wrong++) {
    const field = await screen.findByLabelText("Machine code");
    await userEvent.type(field, "1111");
    await userEvent.click(screen.getByRole("button", { name: "Unlock" }));
    if (wrong < 4) await screen.findByText("That code didn't match. Try again.");
  }
  expect(await screen.findByText("Too many wrong codes. Try again in 15 minutes.")).toBeTruthy();
  expect(screen.getByLabelText("Machine code").hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText(/Working on/)).toBeNull();
});

test("an account machine the relay can't reach says so and never opens the app on nothing", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  const stores = windowStores();
  saveAccountChoice(stores, laptop);
  // A relay that never answers: the connection's state stays unknown.
  const silent: AccountRouteSource = async () => ({
    code: machineCodeGate(async () => "grant"),
    deviceId: "device",
    grantProblem: () => undefined,
    client: () =>
      createBrowserClient({
        deviceId: "device",
        transport: () => ({ open() {}, send() {}, close() {} }),
        credential: async () => "grant",
        storage: memoryStorage(),
      }),
  });
  const deadlines: (() => void)[] = [];
  openWindow({
    daemon,
    stores,
    session: memoryKeyValue(),
    signedIn: true,
    routes: silent,
    schedule: (_delayMs, run) => {
      deadlines.push(run);
      return () => {};
    },
  });
  await waitFor(() => expect(deadlines.length).toBeGreaterThan(0));
  for (const run of deadlines.splice(0)) act(run);
  expect(
    await screen.findByText(
      "Couldn't reach Travel laptop through ace's relay. Is it on, with ace running? ace keeps trying.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.queryByText(/Working on/)).toBeNull();
});

test("a window without ace accounts ignores a stored account machine and opens empty", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token: "a".repeat(64) });
  const stores = windowStores();
  saveAccountChoice(stores, laptop);
  render(
    <AppFrame environment={{}}>
      <ConnectionGate
        stores={stores}
        defaultUrl={url}
        createClient={() => fakeClient(daemon)}
        noMachine={() => <NoMachineApp storage={stores.local} history={createMemoryHistory()} />}
      >
        {() => <p>Working</p>}
      </ConnectionGate>
    </AppFrame>,
  );
  expect(await screen.findByText("Threads run on a machine. Add one to start.")).toBeTruthy();
});
