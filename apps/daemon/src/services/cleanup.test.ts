import { expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    release.resolve();
    expect(await failure).toMatchObject({
      errors: [
        expect.objectContaining({
          message: "Service browser cleanup failed",
          cause: expect.objectContaining({ message: "Service browser cleanup exceeded 8000ms" }),
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

test("dependent cleanup persists its last record while an independent service finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-cleanup-dependencies-"));
  const database = join(root, "account.sqlite");
  const accounts = new DatabaseSync(database);
  accounts.exec("CREATE TABLE records(value TEXT)");
  const store = new Store(":memory:");
  const resources = new Resources();
  const log = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 0,
    redact: (text) => text,
    level: "silent",
  });
  const independent = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const startup = new ServiceStartup({
    resources,
    store,
    log,
    config: readConfig({ ACE_HOME: root, ACE_PORT: "0" }),
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
        name: "accounts",
        phase: "core",
        requires: [],
        after: [],
        start(context) {
          context.resources.own(() => accounts.close());
        },
      },
      {
        name: "engine",
        phase: "core",
        requires: ["accounts"],
        after: [],
        start(context) {
          context.resources.own(async () => {
            await release.promise;
            accounts.exec("INSERT INTO records VALUES('final usage')");
          });
        },
      },
      {
        name: "independent",
        phase: "core",
        requires: [],
        after: [],
        start(context) {
          context.resources.own(async () => {
            await writeFile(join(root, "closed"), "independent finished");
            independent.resolve();
          });
        },
      },
    ]);
    const closing = resources.close();
    const failure = closing.catch((error: unknown) => error);
    await independent.promise;
    expect(await readFile(join(root, "closed"), "utf8")).toBe("independent finished");
    release.resolve();
    expect(await failure).toBeUndefined();
    const reader = new DatabaseSync(database, { readOnly: true });
    try {
      expect(reader.prepare("SELECT value FROM records").get()?.value).toBe("final usage");
    } finally {
      reader.close();
    }
  } finally {
    release.resolve();
    await resources.close().catch(() => {});
    await store.close();
    await log.close();
    await rm(root, { recursive: true, force: true });
  }
});
