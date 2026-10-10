import { Client } from "@ace/client";
import { FakeDaemon, flakyCheckout, ScenarioPlayer } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App, AppFrame } from "@/app.tsx";
import { memoryStorage } from "@/boot/client.ts";
import type { DaemonTarget } from "@/boot/connection-settings.ts";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { fakeClient, memoryKeyValue } from "@/test/harness.tsx";
import { ConnectionGate, firstAttemptMs } from "./connection-gate.tsx";

const token = "ab".repeat(32);
const url = "ws://127.0.0.1:4242/";

/** A client whose socket never opens: a daemon address that swallows packets. */
function silentClient(): Client {
  return new Client({
    deviceId: DeviceId.parse("silent-device"),
    transport: () => ({ open() {}, send() {}, close() {} }),
    credential: async () => token,
    storage: memoryStorage(),
    scheduler: { set: () => () => {} },
    random: () => 0.5,
    id: () => crypto.randomUUID(),
  });
}

/** The gate with its first-attempt deadline in the test's hands. */
function boot(
  options: {
    createClient?: (target: DaemonTarget) => Client | Promise<Client>;
    remembered?: boolean;
    desktop?: boolean;
  } = {},
) {
  const daemon = new FakeDaemon({ clock: () => 1, token });
  new ScenarioPlayer(daemon, flakyCheckout()).runThrough("explorer-spawned");
  const local = memoryKeyValue();
  if (options.remembered) {
    local.setItem("ace.daemon.url", url);
    local.setItem("ace.daemon.token", token);
  }
  const deadlines: { delay: number; run: () => void }[] = [];
  render(
    <AppFrame environment={{}}>
      <ConnectionGate
        stores={{ local, session: memoryKeyValue() }}
        defaultUrl={url}
        desktop={options.desktop ?? false}
        createClient={options.createClient ?? ((target) => fakeClient(daemon, target.token))}
        schedule={(delay, run) => {
          const deadline = { delay, run };
          deadlines.push(deadline);
          return () => {
            deadline.run = () => {};
          };
        }}
      >
        {(client) => (
          <App client={client} history={createMemoryHistory({ initialEntries: ["/"] })} />
        )}
      </ConnectionGate>
    </AppFrame>,
  );
  const runOutFirstAttempt = () =>
    act(() => {
      for (const deadline of deadlines) if (deadline.delay === firstAttemptMs) deadline.run();
    });
  return { daemon, runOutFirstAttempt };
}

async function connect() {
  await userEvent.type(await screen.findByLabelText("Token"), token);
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
}

const shell = () => screen.queryByRole("link", { name: /Fix flaky checkout test/ });

test("a daemon that isn't running is reported on the form, never as the shell", async () => {
  const { daemon } = boot();
  daemon.refuseConnections(true);
  await connect();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/Couldn't reach ws:\/\/127\.0\.0\.1:4242\/\..*ace start/);
  expect(shell()).toBeNull();
  // The token is kept, and the fields wait while the address is being tried.
  expect(screen.getByLabelText<HTMLInputElement>("Token").value).toBe(token);
  expect(screen.getByLabelText<HTMLInputElement>("Token").readOnly).toBe(true);

  daemon.refuseConnections(false);
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("link", { name: /Fix flaky checkout test/ })).toBeTruthy();
});

test("a daemon that never answers is reported once the first attempt runs out", async () => {
  const { runOutFirstAttempt } = boot({ createClient: silentClient });
  await connect();
  const pending = await screen.findByRole("button", { name: "Connecting…" });
  expect(pending.getAttribute("aria-disabled") ?? pending.getAttribute("disabled")).not.toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();

  runOutFirstAttempt();
  expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't reach/);
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("Cancel stops trying and gives the fields back, token kept", async () => {
  boot({ createClient: silentClient });
  await connect();
  await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  const field = screen.getByLabelText<HTMLInputElement>("Token");
  expect(field.readOnly).toBe(false);
  expect(field.value).toBe(token);
  expect(document.activeElement).toBe(field);
  expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
});

test("a remembered daemon that answers opens straight into the app", async () => {
  boot({ remembered: true });
  expect(screen.queryByRole("heading", { name: "Connect to ace" })).toBeNull();
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  expect(screen.queryByRole("heading", { name: "Connect to ace" })).toBeNull();
});

test("a remembered daemon that is down says so instead of a shell stuck reconnecting", async () => {
  const { runOutFirstAttempt } = boot({ remembered: true, createClient: silentClient });
  expect(screen.queryByRole("heading", { name: "Connect to ace" })).toBeNull();
  runOutFirstAttempt();
  expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't reach/);
  expect(shell()).toBeNull();
});

test("inside the desktop app the form never tells the person to start a daemon by hand", async () => {
  const { daemon } = boot({ desktop: true });
  daemon.refuseConnections(true);
  await connect();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/Couldn't reach ace/);
  expect(document.body.textContent).not.toMatch(/ace start/);
});

test("a client that fails to load shows why ace couldn't start, not an endless splash", async () => {
  boot({
    createClient: () => Promise.reject(new Error("Failed to fetch dynamically imported module")),
  });
  await connect();
  expect(await screen.findByRole("heading", { name: "ace couldn't start" })).toBeTruthy();
  expect(screen.getByText("Failed to fetch dynamically imported module")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
});

/** Settings' "Change": point the window at another daemon from inside the app. */
function SwitchTo(props: { target: DaemonTarget }) {
  const connection = useDaemonConnection();
  return (
    <button type="button" onClick={() => connection.connect(props.target, false)}>
      Switch ace
    </button>
  );
}

test("switching daemons never shows the old daemon's app while the new client is loading", async () => {
  const first = new FakeDaemon({ clock: () => 1, token });
  new ScenarioPlayer(first, flakyCheckout()).runThrough("explorer-spawned");
  const second = new FakeDaemon({ clock: () => 1, token });
  const other = { url: "ws://127.0.0.1:5151/", token };
  let arrive: ((client: Client) => void) | undefined;
  render(
    <AppFrame environment={{}}>
      <ConnectionGate
        stores={{ local: memoryKeyValue(), session: memoryKeyValue() }}
        defaultUrl={url}
        createClient={(target) =>
          target.url === other.url
            ? // The in-page client for B arrives later, once its chunk loads.
              new Promise<Client>((resolve) => {
                arrive = resolve;
              })
            : fakeClient(first, target.token)
        }
      >
        {(client) => (
          <>
            <SwitchTo target={other} />
            <App client={client} history={createMemoryHistory({ initialEntries: ["/"] })} />
          </>
        )}
      </ConnectionGate>
    </AppFrame>,
  );
  await connect();
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });

  await userEvent.click(screen.getByRole("button", { name: "Switch ace" }));
  // A's app is gone at once and nothing acts for B before B has welcomed the window.
  expect(shell()).toBeNull();
  expect(screen.queryByRole("button", { name: "Switch ace" })).toBeNull();
  expect(await screen.findByRole("button", { name: "Connecting…" })).toBeTruthy();

  act(() => arrive?.(fakeClient(second, token)));
  await screen.findByRole("button", { name: "Switch ace" });
  expect(shell()).toBeNull();
});

test("desktop startup stays visible and withholds the composer until authenticated welcome, then offers recovery on timeout", async () => {
  const { runOutFirstAttempt } = boot({
    desktop: true,
    remembered: true,
    createClient: silentClient,
  });
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Loading your workspace…",
  );
  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
  runOutFirstAttempt();
  expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't reach/);
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
});
