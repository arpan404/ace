import { afterEach, expect, test } from "vitest";
import { createLogger } from "@ace/diagnostics";
import { Store } from "../store.ts";
import { readConfig } from "../config.ts";
import type { startServer } from "../server.ts";
import { Resources } from "./resources.ts";
import { ServiceStartup, type ServiceDefinition } from "./startup.ts";

type Server = Awaited<ReturnType<typeof startServer>>;
const server = {} as Server;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

function startup() {
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
  return new ServiceStartup({
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
  });
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
