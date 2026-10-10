import { expect, test } from "vitest";
import { createLogger } from "@ace/diagnostics";
import { Store } from "../store.ts";
import { readConfig } from "../config.ts";
import { Resources } from "./resources.ts";
import { ServiceStartup } from "./startup.ts";

test("service cleanup uses its own deadline and names cleanup in its failure", async () => {
  const resources = new Resources();
  const store = new Store(":memory:");
  const log = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 0,
    redact: (text) => text,
    level: "silent",
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let expire: (() => void) | undefined;
  let milliseconds: number | undefined;
  const startup = new ServiceStartup(
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
    {
      timeoutMs: 15_000,
      cleanupTimeoutMs: 8_000,
      schedule(_name, callback, delay) {
        expire = callback;
        milliseconds = delay;
        return () => {
          expire = undefined;
        };
      },
    },
  );
  try {
    await startup.start([
      {
        name: "browser",
        phase: "core",
        requires: [],
        after: [],
        start(context) {
          context.resources.own(async () => {
            entered.resolve();
            await release.promise;
          });
        },
      },
    ]);
    const closing = resources.close();
    const failure = closing.then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    const delay = milliseconds;
    expire?.();
    expect(await failure).toMatchObject({
      errors: [
        expect.objectContaining({
          errors: [expect.objectContaining({ message: "Service browser cleanup exceeded 8000ms" })],
        }),
      ],
    });
    expect(delay).toBe(8_000);
  } finally {
    release.resolve();
    await store.close();
    await log.close();
  }
});

test("one held service does not prevent another service from closing", async () => {
  const resources = new Resources();
  const store = new Store(":memory:");
  const log = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 0,
    redact: (text) => text,
    level: "silent",
  });
  const release = Promise.withResolvers<void>();
  const otherClosed = Promise.withResolvers<void>();
  const startup = new ServiceStartup({
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
  try {
    await startup.start([
      {
        name: "first",
        phase: "core",
        requires: [],
        after: [],
        start(context) {
          context.resources.own(() => otherClosed.resolve());
        },
      },
      {
        name: "held",
        phase: "core",
        requires: [],
        after: ["first"],
        start(context) {
          context.resources.own(() => release.promise);
        },
      },
    ]);
    const closing = resources.close();
    await otherClosed.promise;
    release.resolve();
    await closing;
  } finally {
    release.resolve();
    store.close();
    await log.close();
  }
});
