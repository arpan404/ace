import { afterEach, expect, test, vi } from "vitest";
import { createLogger } from "@ace/diagnostics";
import { Store } from "../store.ts";
import { readConfig } from "../config.ts";
import type { startServer } from "../server.ts";
import { startupAttempts, safeModeSkips } from "../startup-attempts.ts";
import { ServiceScope } from "./service-scope.ts";
import { Resources } from "./resources.ts";
import type { ServiceContext } from "./types.ts";
import { startCommands } from "./commands.ts";
import { repeatableWarmup, warmup } from "./warmup.ts";
import { serviceOrder } from "./service-order.ts";
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
  const retrying = () => subject.status().find((entry) => entry.name === "suits")?.retrying;
  expect(retrying()).toBe(true);
  for (let step = 0; step < 5; step++) await clock.advance(1_000);
  expect(attempts).toBe(3);
  expect(state(subject, "suits")).toBe("degraded");
  expect(clock.pending("retry")).toHaveLength(0);
  expect(retrying()).toBe(false);
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

test("safe mode never leaves off what the engine requires, so a stuck accounts start can't repeat", () => {
  // A start killed while accounts and commands were both still starting.
  expect(safeModeSkips(["accounts", "commands"], serviceOrder)).toEqual(["commands"]);
});

test("safe mode still starts a service an essential one requires, and the daemon comes up", async () => {
  const clock = fakeClock();
  const subject = startup({ timeoutMs: 100, schedule: clock.schedule }, ["accounts"]);
  await subject.start([
    service("accounts", () => {}),
    service("engine", () => {}, { essential: true, requires: ["accounts"] }),
  ]);
  expect(state(subject, "accounts")).toBe("ready");
  expect(state(subject, "engine")).toBe("ready");
});

test("a service an essential one requires stops the start under its own name when it fails", async () => {
  const subject = startup({ timeoutMs: 15_000, schedule: fakeClock().schedule });
  const failure = await subject
    .start([
      service("accounts", () => {
        throw new Error("accounts.sqlite unreadable");
      }),
      service("engine", () => {}, { essential: true, requires: ["accounts"] }),
    ])
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(EssentialServiceError);
  expect(failure).toMatchObject({ service: "accounts" });
});

test("a resource a timed-out start acquires after cleanup fences the retry until it is freed", async () => {
  const clock = fakeClock();
  const acquired = Promise.withResolvers<void>();
  const freed = Promise.withResolvers<void>();
  let starts = 0;
  const running: string[][] = [];
  const marker = startupAttempts({
    read: () => undefined,
    write: (text) => running.push(JSON.parse(text).running),
  });
  const subject = startup({
    timeoutMs: 100,
    cleanupTimeoutMs: 100,
    retryDelaysMs: [1_000, 1_000, 1_000],
    schedule: clock.schedule,
    onAttempt: marker.onAttempt,
  });
  const starting = subject.start([
    service("devices", async (context) => {
      starts++;
      if (starts > 1) return;
      // Still connecting when the deadline passes and its (empty) cleanup has run.
      await acquired.promise;
      context.resources.own(() => freed.promise);
    }),
  ]);
  await clock.advance(100);
  await starting;
  await subject.listening(server);
  acquired.resolve();
  await clock.advance(1_000);
  expect(starts).toBe(1);
  expect(running.at(-1)).toEqual(["devices"]);

  freed.resolve();
  await clock.advance(1_000);
  expect(starts).toBe(2);
  expect(state(subject, "devices")).toBe("ready");
  expect(running.at(-1)).toEqual([]);
});

test("work a service leaves running, from its start and its listener, is charged to it", async () => {
  const scope = new ServiceScope();
  const clock = fakeClock();
  const subject = startup({
    timeoutMs: 15_000,
    schedule: clock.schedule,
    inService: (name, work) => scope.run(name, work),
  });
  const owners: (string | undefined)[] = [];
  const later = Promise.withResolvers<void>();
  await subject.start([
    service("commands", (context) => {
      // Discovery that keeps running after the start returned, and after the daemon listens.
      setTimeout(() => owners.push(scope.current()), 1);
      context.onListen.push(() => {
        void later.promise.then(() => owners.push(scope.current()));
      });
    }),
    service("engine", () => {}, { essential: true }),
  ]);
  await subject.listening(server);
  later.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(owners).toEqual(["commands", "commands"]);
  expect(scope.current()).toBeUndefined();
});

const retryingOf = (subject: ServiceStartup, name: string) =>
  subject.status().find((entry) => entry.name === name)?.retrying;

test("a readiness change after a good start is published to listeners", async () => {
  const subject = startup({ timeoutMs: 15_000, retryDelaysMs: [], schedule: fakeClock().schedule });
  let warm: { name: string; state: "ready" | "degraded"; error?: string } = {
    name: "commands",
    state: "ready",
  };
  let announce: (() => void) | undefined;
  await subject.start([
    service("commands", (context) => {
      announce = () => context.readiness?.(() => warm);
      announce();
    }),
  ]);
  let heard = 0;
  subject.onChange(() => heard++);
  warm = { name: "commands", state: "degraded", error: "warmup failed" };
  announce?.();
  expect(heard).toBeGreaterThan(0);
  expect(state(subject, "commands")).toBe("degraded");
});

test("a warmup that cannot repeat is not promised a retry that never comes", async () => {
  const clock = fakeClock();
  const subject = startup({ timeoutMs: 15_000, retryDelaysMs: [10, 20], schedule: clock.schedule });
  await subject.start([
    service("commands", async (context) => {
      await warmup(context, "commands", async () => {
        throw new Error("warmup failed");
      });
    }),
  ]);
  await subject.listening(server);
  expect(state(subject, "commands")).toBe("degraded");
  expect(clock.pending("retry")).toHaveLength(0);
  expect(retryingOf(subject, "commands")).toBe(false);
});

test("the last retry's stuck cleanup does not keep promising another, and listeners hear it end", async () => {
  const clock = fakeClock();
  const subject = startup({ timeoutMs: 15_000, retryDelaysMs: [10], schedule: clock.schedule });
  const heard: (boolean | undefined)[] = [];
  const stuck = Promise.withResolvers<void>();
  subject.onChange(() => heard.push(retryingOf(subject, "suits")));
  await subject.start([
    service("suits", (context) => {
      // A disposer that never finishes keeps this service's work in flight after it fails.
      context.resources.own(() => stuck.promise);
      throw new Error("still broken");
    }),
  ]);
  await subject.listening(server);
  for (let step = 0; step < 5; step++) await clock.advance(1_000);
  expect(retryingOf(subject, "suits")).toBe(false);
  expect(heard.at(-1)).toBe(false);
  stuck.resolve();
});

test("a repeatable warmup that fails once runs again and ends ready, with no restart of the service", async () => {
  const clock = fakeClock();
  const subject = startup({ timeoutMs: 15_000, retryDelaysMs: [10, 20], schedule: clock.schedule });
  let starts = 0;
  let runs = 0;
  const heard: (boolean | undefined)[] = [];
  subject.onChange(() => heard.push(retryingOf(subject, "usage")));
  await subject.start([
    service("usage", async (context) => {
      starts++;
      await repeatableWarmup(context, "usage", async () => {
        if (++runs === 1) throw new Error("ledger busy");
      });
    }),
  ]);
  await subject.listening(server);
  expect(state(subject, "usage")).toBe("degraded");
  expect(retryingOf(subject, "usage")).toBe(true);
  await clock.advance(10);
  expect(state(subject, "usage")).toBe("ready");
  expect(runs).toBe(2);
  expect(starts).toBe(1);
  expect(heard.at(-1)).toBeUndefined();
});

test("a repeatable warmup that keeps failing stops promising retries once its budget is spent", async () => {
  const clock = fakeClock();
  const subject = startup({ timeoutMs: 15_000, retryDelaysMs: [10, 20], schedule: clock.schedule });
  let runs = 0;
  await subject.start([
    service("usage", async (context) => {
      await repeatableWarmup(context, "usage", async () => {
        runs++;
        throw new Error("ledger busy");
      });
    }),
  ]);
  await subject.listening(server);
  for (let step = 0; step < 5; step++) await clock.advance(1_000);
  expect(runs).toBe(3);
  expect(state(subject, "usage")).toBe("degraded");
  expect(retryingOf(subject, "usage")).toBe(false);
});

test("commands publish at start without waiting on any account, and a failed build is the ordinary retry", async () => {
  const clock = fakeClock();
  const subject = startup({ timeoutMs: 15_000, retryDelaysMs: [10, 20], schedule: clock.schedule });
  let starts = 0;
  let live: ServiceContext["services"] | undefined;
  await subject.start([
    service("commands", async (context) => {
      await startCommands(context);
      // The build is done and registered; the start still fails once, as a real one can.
      if (++starts === 1) throw new Error("library could not open");
    }),
    service("probe", (context) => {
      live = context.services;
    }),
  ]);
  await subject.listening(server);
  expect(state(subject, "commands")).toBe("degraded");
  expect(retryingOf(subject, "commands")).toBe(true);
  expect(live?.commands).toBeUndefined();

  // The retry waits for the failed attempt's cleanup, then starts: a few turns of the clock.
  for (let step = 0; step < 3; step++) await clock.advance(10);
  expect(state(subject, "commands")).toBe("ready");
  expect(starts).toBe(2);
  expect(live?.commands).toBeDefined();
  expect(live?.promptFiles).toBeDefined();
});

/** A plugin service's catalog subscriptions, observable. */
const catalog = () => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    subscribeCatalog: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
};

test("plugins that only start on a retry still reach commands, once, and a replaced plugin service is dropped", async () => {
  const clock = fakeClock();
  const subject = startup({ timeoutMs: 15_000, retryDelaysMs: [10, 20], schedule: clock.schedule });
  const first = catalog();
  let starts = 0;
  let live: ServiceContext["services"] | undefined;
  await subject.start([
    service("commands", (context) => startCommands(context)),
    // Stands in for the plugin service: it fails its first start, then publishes as the real one does.
    service("plugins", (context) => {
      if (++starts === 1) throw new Error("plugin index busy");
      context.services.plugins = first as never;
      context.services.pluginAvailability?.publish(first as never);
    }),
    service("probe", (context) => {
      live = context.services;
    }),
  ]);
  await subject.listening(server);
  expect(state(subject, "plugins")).toBe("degraded");
  expect(first.listeners.size).toBe(0);

  for (let step = 0; step < 3; step++) await clock.advance(10);
  expect(state(subject, "plugins")).toBe("ready");
  const invalidate = vi.spyOn(live!.commands!, "invalidateExtras");
  expect(first.listeners.size).toBe(2);
  for (const listener of first.listeners) listener();
  expect(invalidate).toHaveBeenCalledTimes(1);

  // A replacement plugin service takes over; the old one is no longer followed.
  const second = catalog();
  live!.pluginAvailability!.publish(second as never);
  expect(first.listeners.size).toBe(0);
  expect(second.listeners.size).toBe(2);
});
