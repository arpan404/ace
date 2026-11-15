import { afterEach, expect, test } from "vitest";
import { createLogger } from "@ace/diagnostics";
import { Store } from "../store.ts";
import { readConfig } from "../config.ts";
import type { startServer } from "../server.ts";
import { Resources } from "./resources.ts";
import {
  loadOnStart,
  ServiceStartup,
  type ServiceDefinition,
  type StartupRuntime,
} from "./startup.ts";
import type { Services } from "./types.ts";
import { serviceOrder } from "./service-order.ts";

type Server = Awaited<ReturnType<typeof startServer>>;
const server = {} as Server;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

function startup(runtime?: StartupRuntime, services: Partial<Services> = {}) {
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
  const context = {
    resources,
    store,
    log,
    config: readConfig({ ACE_HOME: "/unused", ACE_PORT: "0" }),
    options: {},
    signal: new AbortController().signal,
    now: () => 0,
    id: () => "id",
    services,
    onListen: [],
  };
  const subject = runtime ? new ServiceStartup(context, runtime) : new ServiceStartup(context);
  return Object.assign(subject, { resources });
}

const core: ServiceDefinition = {
  name: "engine",
  phase: "core",
  requires: [],
  after: [],
  start() {},
};

function listener(
  name: string,
  start: ServiceDefinition["start"],
  dependencies: Partial<Pick<ServiceDefinition, "requires" | "after">> = {},
): ServiceDefinition {
  return {
    name,
    phase: "listener",
    requires: dependencies.requires ?? [],
    after: dependencies.after ?? [],
    start,
  };
}

const state = (services: ServiceStartup, name: string) =>
  services.status().find((entry) => entry.name === name)?.state;

test("an independent listener service is ready while a slow one is still starting", async () => {
  const slow = Promise.withResolvers<void>();
  const services = startup();
  await services.start([
    core,
    listener("usage", () => slow.promise),
    listener("history", () => {}, { after: ["engine"] }),
  ]);
  const listening = services.listening(server);
  await expect.poll(() => state(services, "history")).toBe("ready");
  expect(state(services, "usage")).toBe("starting");
  slow.resolve();
  await listening;
  expect(state(services, "usage")).toBe("ready");
});

test("a listener service waits until the service it starts after has run its listeners", async () => {
  const order: string[] = [];
  const release = Promise.withResolvers<void>();
  const services = startup();
  await services.start([
    core,
    listener("agentControl", (context) => {
      context.onListen.push(async () => {
        await release.promise;
        order.push("agentControl listening");
      });
    }),
    listener(
      "machines",
      () => {
        order.push("machines started");
      },
      { requires: ["agentControl"] },
    ),
  ]);
  const listening = services.listening(server);
  await Promise.resolve();
  expect(order).toEqual([]);
  release.resolve();
  await listening;
  expect(order).toEqual(["agentControl listening", "machines started"]);
  expect(state(services, "machines")).toBe("ready");
});

test("a failed listener service still degrades and skips the services that require it", async () => {
  const services = startup();
  await services.start([
    core,
    listener("context", () => {
      throw new Error("index unreadable");
    }),
    listener("storage", () => {}, { requires: ["context"] }),
    listener("review", () => {}),
  ]);
  await services.listening(server);
  expect(services.status().filter((entry) => entry.name !== "engine")).toEqual([
    { name: "context", state: "degraded", error: "Service context: index unreadable" },
    {
      name: "storage",
      state: "degraded",
      error: "Service storage: Dependency context is unavailable",
    },
    { name: "review", state: "ready" },
  ]);
});

/** A startup deadline the test expires, and a service module that loads when told to. */
function lateModule() {
  const timers = new Set<() => void>();
  const runtime: StartupRuntime = {
    timeoutMs: 15_000,
    schedule(_name, expire) {
      timers.add(expire);
      return () => timers.delete(expire);
    },
  };
  const loaded = Promise.withResolvers<void>();
  let entered = false;
  const definition = listener(
    "agentControl",
    loadOnStart(async () => {
      await loaded.promise;
      return {
        startAgentControl: (context: Parameters<ServiceDefinition["start"]>[0]) => {
          entered = true;
          // What the real service installs on the live engine and registry.
          context.services.agentControl = {} as NonNullable<Services["agentControl"]>;
        },
      };
    }, "startAgentControl"),
  );
  return {
    runtime,
    definition,
    expire: () => {
      for (const expire of timers) expire();
    },
    armed: () => timers.size,
    load: () => loaded.resolve(),
    entered: () => entered,
  };
}

test("a service whose module loads after its start timed out is never started", async () => {
  const late = lateModule();
  const services: Partial<Services> = {};
  const subject = startup(late.runtime, services);
  await subject.start([core, late.definition]);
  const listening = subject.listening(server);
  await expect.poll(late.armed).toBe(1);
  late.expire();
  await listening;
  expect(state(subject, "agentControl")).toBe("degraded");
  late.load();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(late.entered()).toBe(false);
  expect(services.agentControl).toBeUndefined();
});

test("a service whose module loads after shutdown began is never started", async () => {
  const late = lateModule();
  const services: Partial<Services> = {};
  const subject = startup(late.runtime, services);
  await subject.start([core, late.definition]);
  const listening = subject.listening(server).catch(() => {});
  await expect.poll(late.armed).toBe(1);
  const closing = subject.resources.close().catch(() => {});
  late.load();
  await listening;
  await closing;
  expect(late.entered()).toBe(false);
  expect(services.agentControl).toBeUndefined();
});

/** The daemon's own service order, each start replaced by one the test watches and holds. */
function daemonOrder(hold: Partial<Record<string, Promise<void>>>, fail: readonly string[] = []) {
  const entered = new Set<string>();
  const definitions: ServiceDefinition[] = serviceOrder.map((entry) =>
    Object.assign({}, entry, {
      async start() {
        entered.add(entry.name);
        if (fail.includes(entry.name)) throw new Error(`${entry.name} failed`);
        await hold[entry.name];
      },
    }),
  );
  return { definitions, entered };
}

/** Services that start work on their own (outside clients, Spade, scheduled runs) or move threads. */
const workStarters = ["externalMcp", "spade", "automations", "threadOrganization", "storage"];

test("outside clients, Spade and scheduled runs start no work before machines and transfers are up", async () => {
  const machines = Promise.withResolvers<void>();
  const transfers = Promise.withResolvers<void>();
  const order = daemonOrder({ machines: machines.promise, transfers: transfers.promise });
  const subject = startup();
  await subject.start(order.definitions);
  const listening = subject.listening(server);
  await expect.poll(() => order.entered.has("machines")).toBe(true);
  // Independent services still start meanwhile.
  await expect.poll(() => state(subject, "usage")).toBe("ready");
  for (const name of [...workStarters, "transfers"]) expect(order.entered.has(name)).toBe(false);
  machines.resolve();
  await expect.poll(() => order.entered.has("transfers")).toBe(true);
  for (const name of workStarters) expect(order.entered.has(name)).toBe(false);
  transfers.resolve();
  await listening;
  for (const name of workStarters) expect(state(subject, name)).toBe("ready");
});

test("agent control failing keeps machines and transfers off, and Spade and scheduled runs still start", async () => {
  const order = daemonOrder({}, ["agentControl"]);
  const subject = startup();
  await subject.start(order.definitions);
  await subject.listening(server);
  for (const name of ["machines", "transfers", "externalMcp"]) {
    expect(order.entered.has(name)).toBe(false);
    expect(subject.status().find((entry) => entry.name === name)).toMatchObject({
      state: "degraded",
      error: `Service ${name}: Dependency agentControl is unavailable`,
    });
  }
  for (const name of ["spade", "automations", "storage"])
    expect(state(subject, name)).toBe("ready");
});
