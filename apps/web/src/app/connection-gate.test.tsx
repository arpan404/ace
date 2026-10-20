import { Client, ClientError, type TransportEvents } from "@ace/client";
import { FakeDaemon, fakeTransport, flakyCheckout, ScenarioPlayer } from "@ace/fake-daemon";
import { DeviceId, ServerMessage } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test } from "vitest";
import { App, AppFrame } from "@/app.tsx";
import { memoryStorage } from "@/boot/client.ts";
import type { DaemonTarget } from "@/boot/connection-settings.ts";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { deviceId } from "@/boot/device-id.ts";
import { knownHost, rememberHost } from "@/boot/known-host.ts";
import { fakeClient, memoryKeyValue } from "@/test/harness.tsx";
import { ConnectionGate, firstAttemptMs, identityMs } from "./connection-gate.tsx";

const token = "ab".repeat(32);
const url = "ws://127.0.0.1:4242/";
const hostId = "30f6c4b7-ee27-4793-8c80-7613f816a314";

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

/** The host the app was mounted for: a later host must mount a fresh app, caches and all. */
function MountedFor(props: { hostId: string }) {
  const [mounted] = useState(props.hostId);
  return <output aria-label="Opened for">{mounted}</output>;
}

/** The gate with its first-attempt deadline in the test's hands. */
function boot(
  options: {
    createClient?: (target: DaemonTarget, daemon: FakeDaemon) => Client | Promise<Client>;
    remembered?: boolean;
    desktop?: boolean;
    /** The host this device met at the remembered address on an earlier visit. */
    known?: string;
  } = {},
) {
  const daemon = new FakeDaemon({ clock: () => 1, token });
  new ScenarioPlayer(daemon, flakyCheckout()).runThrough("explorer-spawned");
  const local = memoryKeyValue();
  if (options.remembered) {
    local.setItem("ace.daemon.url", url);
    local.setItem("ace.daemon.token", token);
  }
  if (options.known) rememberHost(local, { url, token }, deviceId(), options.known);
  const deadlines: { delay: number; run: () => void }[] = [];
  render(
    <AppFrame environment={{}}>
      <ConnectionGate
        stores={{ local, session: memoryKeyValue() }}
        defaultUrl={url}
        desktop={options.desktop ?? false}
        createClient={(target) =>
          options.createClient
            ? options.createClient(target, daemon)
            : fakeClient(daemon, target.token)
        }
        schedule={(delay, run) => {
          const deadline = { delay, run };
          deadlines.push(deadline);
          return () => {
            deadline.run = () => {};
          };
        }}
      >
        {(client, connection) => (
          <>
            <MountedFor hostId={connection.hostId} />
            <App client={client} history={createMemoryHistory({ initialEntries: ["/"] })} />
          </>
        )}
      </ConnectionGate>
    </AppFrame>,
  );
  const runOut = (delay: number) =>
    act(() => {
      for (const deadline of deadlines) if (deadline.delay === delay) deadline.run();
    });
  return {
    daemon,
    local,
    runOutFirstAttempt: () => runOut(firstAttemptMs),
    runOut,
  };
}

/** A client whose daemon welcomes it with a protocol version this build doesn't speak. */
function otherVersionClient(): Client {
  return new Client({
    deviceId: DeviceId.parse("other-version-device"),
    transport: () => {
      let events: TransportEvents | undefined;
      return {
        open(next) {
          events = next;
          queueMicrotask(next.open);
        },
        send(text) {
          if (JSON.parse(text).type !== "hello") return;
          const welcome = { type: "welcome", hostId, protocolVersion: 2, headSeq: 0 };
          queueMicrotask(() => events?.message(JSON.stringify(welcome)));
        },
        close() {},
      };
    },
    credential: async () => token,
    storage: memoryStorage(),
    scheduler: { set: () => () => {} },
    random: () => 0.5,
    id: () => crypto.randomUUID(),
  });
}

/**
 * A worker-style client (no welcome on its public channel) whose host identity reads go
 * through `identity` instead of the daemon.
 */
function identityClient(daemon: FakeDaemon, identity: () => Promise<never> | undefined) {
  const client = fakeClient(daemon, token);
  const listen = client.onMessage.bind(client);
  client.onMessage = (listener) =>
    listen((frame) => {
      if (frame.type !== "welcome") listener(frame);
    });
  const request = client.request.bind(client);
  client.request = ((message, options) =>
    (message.type === "host.identity" ? identity() : undefined) ??
    request(message, options)) as Client["request"];
  return client;
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

test("a daemon of another version is named on the form rather than reported unreachable", async () => {
  boot({ createClient: otherVersionClient });
  await connect();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "This app and the ace daemon are different versions. Restart ace to update.",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(shell()).toBeNull();
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

const openedFor = () => screen.queryByRole("status", { name: "Opened for" })?.textContent;

test("a daemon this device met before opens the app at once, before it answers", async () => {
  const { runOutFirstAttempt } = boot({
    remembered: true,
    known: hostId,
    createClient: silentClient,
  });
  expect(openedFor()).toBe(hostId);
  await screen.findByRole("navigation", { name: "Threads" });
  // Still unreachable: the shell stays, on what this device kept, rather than the form.
  runOutFirstAttempt();
  expect(screen.queryByRole("heading", { name: "Connect to ace" })).toBeNull();
  expect(openedFor()).toBe(hostId);
});

test("a daemon that answers remembers its host, so the next load opens at once", async () => {
  const { daemon, local } = boot({ remembered: true });
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  expect(knownHost(local, { url, token }, deviceId())).toBe(daemon.hostId);
});

test("a known daemon that refuses the token returns to the form and the next load waits", async () => {
  const { local } = boot({
    remembered: true,
    known: hostId,
    createClient: (_target, daemon) => fakeClient(daemon, "cd".repeat(32)),
  });
  expect(openedFor()).toBe(hostId);
  await screen.findByRole("heading", { name: "Connect to ace" });
  expect(openedFor()).toBeUndefined();
  expect(knownHost(local, { url, token }, deviceId())).toBeUndefined();
});

test("another daemon answering at a known address reopens the app for the one that answered", async () => {
  const { daemon, local } = boot({ remembered: true, known: hostId });
  expect(openedFor()).toBe(hostId);
  await waitFor(() => expect(openedFor()).toBe(daemon.hostId));
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  expect(knownHost(local, { url, token }, deviceId())).toBe(daemon.hostId);
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
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Connecting…");
  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
  runOutFirstAttempt();
  expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't reach/);
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
});

test("a cold start says Starting after ace answers, rather than unreachable at the first-attempt deadline", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token });
  new ScenarioPlayer(daemon, flakyCheckout()).runThrough("explorer-spawned");
  let welcome: (() => void) | undefined;
  const gate = boot({
    remembered: true,
    createClient: () =>
      new Client({
        deviceId: DeviceId.parse("startup-device"),
        credential: async () => token,
        transport: () => {
          const inner = fakeTransport(daemon);
          return {
            ...inner,
            open(events) {
              inner.open({
                ...events,
                message(text) {
                  const message = ServerMessage.parse(JSON.parse(text));
                  if (message.type === "welcome") {
                    welcome = () => events.message(text);
                    events.message(JSON.stringify({ type: "starting" }));
                  } else events.message(text);
                },
              });
            },
          };
        },
        storage: memoryStorage(),
        scheduler: { set: () => () => {} },
        random: () => 0.5,
        id: () => crypto.randomUUID(),
      }),
  });
  expect(await screen.findByText("Starting ace…")).toBeTruthy();
  gate.runOutFirstAttempt();
  expect(screen.queryByText(/Couldn't reach/)).toBeNull();
  act(() => welcome?.());
  expect(await screen.findByRole("link", { name: /Fix flaky checkout test/ })).toBeTruthy();
});

test("Try again recovers a fatal connection after the workspace has opened", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token });
  new ScenarioPlayer(daemon, flakyCheckout()).runThrough("explorer-spawned");
  let corrupt: (() => void) | undefined;
  boot({
    remembered: true,
    createClient: () =>
      new Client({
        deviceId: DeviceId.parse("fatal-device"),
        credential: async () => token,
        transport: () => {
          const inner = fakeTransport(daemon);
          return {
            ...inner,
            open(events) {
              // A frame the socket can't represent; unreadable JSON reconnects instead.
              corrupt = () => events.close(4002, "Unsupported frame type");
              inner.open(events);
            },
          };
        },
        storage: memoryStorage(),
        scheduler: { set: () => () => {} },
        random: () => 0.5,
        id: () => crypto.randomUUID(),
      }),
  });
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  act(() => corrupt?.());
  await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByText(/Can't connect:/)).toBeNull());
  expect(await screen.findByRole("link", { name: /Fix flaky checkout test/ })).toBeTruthy();
});

test("a frame from a daemon of another version keeps the workspace and says so in its notice", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token });
  new ScenarioPlayer(daemon, flakyCheckout()).runThrough("explorer-spawned");
  let newer: (() => void) | undefined;
  boot({
    remembered: true,
    createClient: () =>
      new Client({
        deviceId: DeviceId.parse("mismatch-device"),
        credential: async () => token,
        transport: () => {
          const inner = fakeTransport(daemon);
          return {
            ...inner,
            open(events) {
              newer = () => events.message(JSON.stringify({ type: "thread.teleported" }));
              inner.open(events);
            },
          };
        },
        storage: memoryStorage(),
        scheduler: { set: () => () => {} },
        random: () => 0.5,
        id: () => crypto.randomUUID(),
      }),
  });
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  act(() => newer?.());
  const notice = await screen.findByText(/different versions/);
  expect(notice.textContent).toContain(
    "This app and the ace daemon are different versions. Restart ace to update.",
  );
  expect(screen.queryByText(/Can't connect:/)).toBeNull();
  expect(screen.getByRole("link", { name: /Fix flaky checkout test/ })).toBeTruthy();
});

test("a connected client whose host identity reply can't be read fails with Try again instead of an endless splash", async () => {
  let broken = true;
  boot({
    remembered: true,
    createClient: (_target, daemon) =>
      identityClient(daemon, () =>
        broken
          ? Promise.reject(
              new ClientError("protocol", "Zod's .loose() is left out of browser builds."),
            )
          : undefined,
      ),
  });
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("This app couldn't read what ace sent.");
  expect(alert.textContent).toContain(".loose() is left out of browser builds");
  expect(shell()).toBeNull();
  broken = false;
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("link", { name: /Fix flaky checkout test/ })).toBeTruthy();
});

test("a connected client that never learns its host identity fails once the wait runs out", async () => {
  const { runOut } = boot({
    remembered: true,
    createClient: (_target, daemon) => identityClient(daemon, () => new Promise<never>(() => {})),
  });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(shell()).toBeNull();
  runOut(identityMs);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "didn't say which machine it is",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("a worker-style client is identified before its App can create terminal close intents", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token, hostId: "gate-close-identity" });
  const arrived = Promise.withResolvers<void>();
  let release: (() => void) | undefined;
  const client = new Client({
    deviceId: DeviceId.parse("identity-device"),
    credential: async () => token,
    storage: memoryStorage(),
    transport: () => {
      const transport = fakeTransport(daemon);
      return {
        ...transport,
        open(events) {
          transport.open({
            ...events,
            message(text) {
              const frame = ServerMessage.parse(JSON.parse(text));
              if (frame.type === "host.identity.result") {
                release = () => events.message(text);
                arrived.resolve();
              } else events.message(text);
            },
          });
        },
      };
    },
    scheduler: {
      set(delay, callback) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: (() => {
      let id = 0;
      return () => `identity-${++id}`;
    })(),
  });
  // A worker's public message channel excludes welcome; correlated identity reads still work.
  const listen = client.onMessage.bind(client);
  client.onMessage = (listener) =>
    listen((frame) => {
      if (frame.type !== "welcome") listener(frame);
    });
  const local = memoryKeyValue();
  local.setItem("ace.daemon.url", url);
  local.setItem("ace.daemon.token", token);
  const view = render(
    <AppFrame environment={{}}>
      <ConnectionGate
        stores={{ local, session: memoryKeyValue() }}
        defaultUrl={url}
        createClient={() => client}
      >
        {() => <output>Identified workspace</output>}
      </ConnectionGate>
    </AppFrame>,
  );
  await act(async () => {
    await arrived.promise;
  });
  expect(client.state).toBe("ready");
  expect(screen.queryByText("Identified workspace")).toBeNull();
  await act(async () => {
    release?.();
  });
  expect(await screen.findByText("Identified workspace")).toBeTruthy();
  view.unmount();
  await client.close();
});
