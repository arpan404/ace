import { afterEach, expect, test } from "vitest";
import { createLogger } from "@ace/diagnostics";
import { Store } from "../store.ts";
import { readConfig } from "../config.ts";
import type { startServer } from "../server.ts";
import { startupAttempts, safeModeSkips } from "../startup-attempts.ts";
import { Resources } from "./resources.ts";
import {
  EssentialServiceError,
  ServiceStartup,
  type ServiceDefinition,
  type StartupRuntime,
} from "./startup.ts";

type Server = Awaited<ReturnType<typeof startServer>>;
const server = {} as Server;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
};

/** Timers the test moves forward by hand. */
function fakeClock() {
  let now = 0;
  const timers = new Set<{ name: string; at: number; fire: () => void }>();
  return {
    schedule(name: string, fire: () => void, milliseconds: number) {
      const timer = { name, at: now + milliseconds, fire };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    pending: (prefix: string) => [...timers].filter((timer) => timer.name.startsWith(prefix)),
    /** Moves time on, firing what falls due, including timers set by what fired. */
    async advance(milliseconds: number) {
      // Work already started sets its timers at the current time, before time moves.
      await settle();
      now += milliseconds;
      for (;;) {
        await settle();
        const due = [...timers].filter((timer) => timer.at <= now).toSorted((a, b) => a.at - b.at);
        if (!due.length) return;
        for (const timer of due) {
          timers.delete(timer);
          timer.fire();
        }
      }
    },
  };
}

function startup(runtime: StartupRuntime, skip: readonly string[] = []) {
  const resources = new Resources();
  const store = new Store(":memory:");
  const log = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 0,
    redact: (text) => text,
    level: "silent",
  });
  open.push(async () => {
    await resources.close().catch(() => {});
    await store.close();
    await log.close();
  });
  const subject = new ServiceStartup(
    {
      resources,
      store,
      log,
      config: readConfig({ ACE_HOME: "/unused", ACE_PORT: "0" }),
      options: {},
      signal: new AbortController().signal,
      now: () => 0,
      id: () => "id",
      services: {},
      onListen: [],
    },
    runtime,
    skip,
  );
  return Object.assign(subject, { resources });
}

function service(
  name: string,
  start: ServiceDefinition["start"],
  extra: Partial<Omit<ServiceDefinition, "name" | "start">> = {},
): ServiceDefinition {
  return { name, phase: "core", requires: [], after: [], ...extra, start };
}

const never = () => new Promise<void>(() => {});
const state = (subject: ServiceStartup, name: string) =>
  subject.status().find((entry) => entry.name === name)?.state;

test("a service whose start never returns degrades alone and the daemon still starts", async () => {
  const clock = fakeClock();
  const subject = startup({ timeoutMs: 15_000, schedule: clock.schedule });
  const starting = subject.start([
    service("commands", never),
    service("engine", () => {}, { essential: true }),
  ]);
  await clock.advance(15_000);
  await starting;
  await subject.listening(server);
  expect(state(subject, "commands")).toBe("degraded");
  expect(state(subject, "engine")).toBe("ready");
});

test("an essential service that fails still stops the start", async () => {
  const subject = startup({ timeoutMs: 15_000, schedule: fakeClock().schedule });
  await expect(
    subject.start([
      service(
        "engine",
        () => {
          throw new Error("store unreadable");
        },
        { essential: true },
      ),
    ]),
  ).rejects.toBeInstanceOf(EssentialServiceError);
});

test("a degraded service is retried after its backoff, and services that require it follow", async () => {
  const clock = fakeClock();
  let failures = 2;
  const subject = startup({
    timeoutMs: 15_000,
    retryDelaysMs: [30_000, 60_000],
    schedule: clock.schedule,
  });
  await subject.start([
    service("plugins", () => {
      if (failures-- > 0) throw new Error("folder not answering");
    }),
    service("marketplace", () => {}, { requires: ["plugins"] }),
  ]);
  await subject.listening(server);
  expect(state(subject, "plugins")).toBe("degraded");
  expect(state(subject, "marketplace")).toBe("degraded");

  await clock.advance(30_000);
  expect(state(subject, "plugins")).toBe("degraded");
  await clock.advance(60_000);
  expect(state(subject, "plugins")).toBe("ready");
  expect(state(subject, "marketplace")).toBe("ready");
});

test("a service that never recovers stays degraded once its retries are spent", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const subject = startup({ timeoutMs: 15_000, retryDelaysMs: [10, 20], schedule: clock.schedule });
  await subject.start([
    service("suits", () => {
      attempts++;
      throw new Error("still broken");
    }),
  ]);
  await subject.listening(server);
  for (let step = 0; step < 5; step++) await clock.advance(1_000);
  expect(attempts).toBe(3);
  expect(state(subject, "suits")).toBe("degraded");
  expect(clock.pending("retry")).toHaveLength(0);
});

test("a retry does not stack a new start on one still stuck in a call", async () => {
  const clock = fakeClock();
  let starts = 0;
  const stuck = Promise.withResolvers<void>();
  const subject = startup({
    timeoutMs: 100,
    retryDelaysMs: [10, 10, 10],
    schedule: clock.schedule,
  });
  const starting = subject.start([
    service("files", async () => {
      starts++;
      if (starts === 1) await stuck.promise;
    }),
  ]);
  await clock.advance(100);
  await starting;
  await subject.listening(server);
  await clock.advance(10);
  expect(starts).toBe(1);

  stuck.resolve();
  await clock.advance(10);
  expect(starts).toBe(2);
  expect(state(subject, "files")).toBe("ready");
});

test("shutdown ends within one budget even when a dependent's cleanup never finishes", async () => {
  const clock = fakeClock();
  const subject = startup({ timeoutMs: 15_000, cleanupTimeoutMs: 6_000, schedule: clock.schedule });
  let settingsClosed = false;
  await subject.start([
    service("settings", (context) => {
      context.resources.own(() => {
        settingsClosed = true;
      });
    }),
    service(
      "browser",
      (context) => {
        context.resources.own(never);
      },
      { after: ["settings"] },
    ),
  ]);
  await subject.listening(server);
  let closed = false;
  const closing = subject.resources.close().finally(() => {
    closed = true;
  });
  await clock.advance(5_999);
  expect(closed).toBe(false);
  await clock.advance(1);
  await closing;
  expect(settingsClosed).toBe(true);
});

test("safe mode leaves off the services the last run was stuck starting, never an essential one", async () => {
  const clock = fakeClock();
  let text: string | undefined;
  const file = {
    read: () => text,
    write: (next: string) => {
      text = next;
    },
  };
  const order = [
    service("commands", never),
    service("engine", never, { essential: true }),
    service("icons", () => {}),
  ];
  // The first run is killed while both starts are still stuck in their calls.
  const first = startupAttempts(file);
  const crashed = startup({ timeoutMs: 100, schedule: clock.schedule, onAttempt: first.onAttempt });
  void crashed.start(order).catch(() => {});
  await clock.advance(100);

  const next = startupAttempts(file);
  const skip = safeModeSkips(next.previous, order);
  expect(skip).toEqual(["commands"]);
  let commandsStarted = false;
  const safe = startup({ timeoutMs: 100, schedule: clock.schedule, retryDelaysMs: [10] }, skip);
  await safe.start([
    service("commands", () => {
      commandsStarted = true;
    }),
    service("engine", () => {}, { essential: true }),
    service("icons", () => {}),
  ]);
  await safe.listening(server);
  await clock.advance(1_000);
  expect(commandsStarted).toBe(false);
  expect(safe.status().find((entry) => entry.name === "commands")).toMatchObject({
    state: "degraded",
    error: expect.stringContaining("Turned off for this run"),
  });
  expect(state(safe, "engine")).toBe("ready");
});

test("a retry waits for the last attempt's cleanup to finish, not only for its deadline", async () => {
  const clock = fakeClock();
  const released = Promise.withResolvers<void>();
  let starts = 0;
  const running: string[][] = [];
  const marker = startupAttempts({
    read: () => undefined,
    write: (text) => running.push(JSON.parse(text).running),
  });
  const subject = startup({
    timeoutMs: 15_000,
    cleanupTimeoutMs: 100,
    retryDelaysMs: [30_000, 30_000, 30_000],
    schedule: clock.schedule,
    onAttempt: marker.onAttempt,
  });
  await subject.start([
    service("userBrowser", (context) => {
      starts++;
      if (starts > 1) return;
      // The first owner holds a port it frees only when this close returns.
      context.resources.own(() => released.promise);
      throw new Error("browser did not start");
    }),
  ]);
  await subject.listening(server);
  await clock.advance(30_000);
  await clock.advance(30_000);
  expect(starts).toBe(1);
  expect(running.at(-1)).toEqual(["userBrowser"]);

  released.resolve();
  await clock.advance(30_000);
  expect(starts).toBe(2);
  expect(state(subject, "userBrowser")).toBe("ready");
  expect(running.at(-1)).toEqual([]);
});

test("a listener stuck in its call is not replaced until that call returns", async () => {
  const clock = fakeClock();
  const connecting = Promise.withResolvers<void>();
  let listens = 0;
  const subject = startup({
    timeoutMs: 100,
    cleanupTimeoutMs: 100,
    retryDelaysMs: [1_000, 1_000, 1_000],
    schedule: clock.schedule,
  });
  await subject.start([
    service("notifications", (context) => {
      context.onListen.push(async () => {
        listens++;
        // The first listener is stuck connecting a device.
        if (listens === 1) await connecting.promise;
      });
    }),
  ]);
  const listening = subject.listening(server);
  await clock.advance(100);
  await listening;
  expect(state(subject, "notifications")).toBe("degraded");
  await clock.advance(1_000);
  expect(listens).toBe(1);

  connecting.resolve();
  await clock.advance(1_000);
  expect(listens).toBe(2);
  expect(state(subject, "notifications")).toBe("ready");
});
