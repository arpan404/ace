import { afterEach, expect, test } from "vitest";
import { createLogger } from "@ace/diagnostics";
import type { BrowserService } from "@ace/browser";
import { BrowserState, ThreadId } from "@ace/protocol";
import { Store } from "../store.ts";
import { readConfig } from "../config.ts";
import type { startServer } from "../server.ts";
import { Resources } from "./resources.ts";
import { startBrowsing } from "./browsing.ts";
import { ServiceStartup, type ServiceDefinition } from "./startup.ts";
import type { Services } from "./types.ts";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
};

/** Just the part of ace's browser the browsing indicator follows: its state changes. */
function stubBrowser() {
  const observers = new Set<(state: BrowserState) => void>();
  const browser = {
    observeStates(observer: (state: BrowserState) => void) {
      observers.add(observer);
      return () => void observers.delete(observer);
    },
  };
  return {
    // The indicator reads nothing else from the service.
    browser: browser as unknown as BrowserService,
    agentWorksIn(threadId: string) {
      const state = BrowserState.parse({
        threadId,
        url: "https://example.com/",
        closed: false,
        tabs: [
          {
            tabId: "t1",
            url: "https://example.com/",
            title: "Example",
            inUse: { kind: "agent", agentId: "root" },
          },
        ],
      });
      for (const observer of observers) observer(state);
    },
  };
}

function startup() {
  const resources = new Resources();
  const store = new Store(":memory:");
  const log = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 0,
    redact: (text) => text,
    level: "silent",
  });
  const services: Partial<Services> = {};
  const timers: (() => void)[] = [];
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
      services,
      onListen: [],
    },
    {
      timeoutMs: 15_000,
      retryDelaysMs: [10],
      schedule(name, fire) {
        // Deadlines never pass; retries wait for `retry()`.
        if (name.startsWith("retry")) timers.push(fire);
        return () => {};
      },
    },
  );
  const retry = async () => {
    for (const fire of timers.splice(0)) fire();
    await settle();
  };
  return { subject, services, retry };
}

const service = (
  name: string,
  start: ServiceDefinition["start"],
  after: readonly string[] = [],
): ServiceDefinition => ({ name, phase: "core", requires: [], after, start });

test("the browsing indicator hears agents in a browser that started on a retry", async () => {
  const { subject, services, retry } = startup();
  const stub = stubBrowser();
  let attempts = 0;
  await subject.start([
    service("browser", (context) => {
      if (++attempts === 1) throw new Error("desktop credential unwritable");
      context.services.browser = stub.browser;
    }),
    service("browsing", startBrowsing, ["browser"]),
  ]);
  await subject.listening({} as Awaited<ReturnType<typeof startServer>>);
  expect(services.browser).toBeUndefined();
  await retry();
  expect(services.browser).toBe(stub.browser);

  stub.agentWorksIn("thread-1");
  expect(services.browsing?.threads()).toEqual([ThreadId.parse("thread-1")]);
});
