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
import { followService } from "./service-watch.ts";
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
    // A failed attempt's cleanup finishes first, or startup puts the retry off.
    await settle();
    for (const fire of timers.splice(0)) fire();
    await settle();
  };
  return { subject, services, retry, resources };
}

const server = {} as Awaited<ReturnType<typeof startServer>>;
const state = (subject: ServiceStartup, name: string) =>
  subject.status().find((entry) => entry.name === name)?.state;

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
  await subject.listening(server);
  expect(services.browser).toBeUndefined();
  await retry();
  expect(services.browser).toBe(stub.browser);

  stub.agentWorksIn("thread-1");
  expect(services.browsing?.threads()).toEqual([ThreadId.parse("thread-1")]);
});

test("a follower whose first look throws keeps running and still hears the browser arrive", async () => {
  const { subject, retry } = startup();
  const stub = stubBrowser();
  let attempts = 0;
  const heard: unknown[] = [];
  let first = true;
  await subject.start([
    service("browser", (context) => {
      if (++attempts === 1) throw new Error("desktop credential unwritable");
      context.services.browser = stub.browser;
    }),
    service(
      "browsing",
      (context) => {
        context.resources.own(
          followService(context, "browser", (browser) => {
            if (first) {
              first = false;
              throw new Error("not ready to look yet");
            }
            heard.push(browser);
          }),
        );
      },
      ["browser"],
    ),
  ]);
  await subject.listening(server);
  expect(state(subject, "browsing")).toBe("ready");
  await retry();
  expect(heard).toEqual([stub.browser]);
});

test("a follower never hears an older browser after a newer one", async () => {
  const { subject, retry } = startup();
  const older = stubBrowser();
  const newer = stubBrowser();
  let attempts = 0;
  let browserServices: Partial<Services> | undefined;
  const heard: unknown[] = [];
  await subject.start([
    service("browser", (context) => {
      if (++attempts === 1) throw new Error("desktop credential unwritable");
      browserServices = context.services;
      context.services.browser = older.browser;
    }),
    // The first follower replaces the browser as soon as it sees the older one.
    service(
      "browsing",
      (context) => {
        context.resources.own(
          followService(context, "browser", (browser) => {
            if (browser === older.browser && browserServices)
              browserServices.browser = newer.browser;
          }),
        );
      },
      ["browser"],
    ),
    service(
      "mcp",
      (context) => {
        context.resources.own(followService(context, "browser", (browser) => heard.push(browser)));
      },
      ["browser"],
    ),
  ]);
  await subject.listening(server);
  await retry();
  expect(heard.at(-1)).toBe(newer.browser);
  expect(heard.slice(heard.indexOf(newer.browser))).not.toContain(older.browser);
});

test("a browser that fails after publishing is withdrawn; only its replacement moves the indicator", async () => {
  const { subject, services, retry, resources } = startup();
  const failing = stubBrowser();
  const replacement = stubBrowser();
  let attempts = 0;
  await subject.start([
    service("browser", (context) => {
      if (++attempts === 1) {
        // Published late, once the daemon listens; then the service fails.
        context.onListen.push(() => void (context.services.browser = failing.browser));
        context.onListen.push(() => {
          failing.agentWorksIn("thread-1");
          throw new Error("browser listener failed");
        });
        return;
      }
      context.services.browser = replacement.browser;
    }),
    service("browsing", startBrowsing, ["browser"]),
  ]);
  await subject.listening(server);
  expect(state(subject, "browser")).toBe("degraded");
  expect(services.browser).toBeUndefined();
  expect(services.browsing?.threads()).toEqual([]);

  await retry();
  expect(services.browser).toBe(replacement.browser);
  failing.agentWorksIn("thread-2");
  expect(services.browsing?.threads()).toEqual([]);
  replacement.agentWorksIn("thread-3");
  expect(services.browsing?.threads()).toEqual([ThreadId.parse("thread-3")]);

  // Shutdown withdraws it as well.
  await resources.close();
  expect(services.browser).toBeUndefined();
});

test("a service's own disposer still sees what it published, at shutdown and when it fails", async () => {
  const { subject, resources } = startup();
  const seen: string[] = [];
  let attempts = 0;
  await subject.start([
    // Like source control: its disposer closes the service through its own slot.
    service("sourceControl", (context) => {
      context.services.sourceControl = {
        close: () => void seen.push("source control closed"),
      } as unknown as Services["sourceControl"];
      context.resources.own(() => context.services.sourceControl?.close());
    }),
    // Published late, then the service fails: its disposer still reads what it published.
    service("models", (context) => {
      if (++attempts > 1) return;
      context.onListen.push(() => {
        context.services.modelsReady = Promise.resolve();
      });
      context.onListen.push(() => {
        throw new Error("models listener failed");
      });
      context.resources.own(async () => {
        if (context.services.modelsReady) seen.push("models waited");
        await context.services.modelsReady;
      });
    }),
  ]);
  await subject.listening(server);
  await settle();
  expect(seen).toEqual(["models waited"]);
  await resources.close();
  expect(seen).toEqual(["models waited", "source control closed"]);
});
