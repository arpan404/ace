import { afterEach, expect, test } from "vitest";
import { z } from "zod";
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

/** A startup on a clock the services advance, whose info lines the test reads back. */
function startup() {
  let time = 1_000;
  const resources = new Resources();
  const store = new Store(":memory:");
  const log = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => time,
    redact: (text) => text,
    level: "info",
  });
  open.push(async () => {
    await resources.close().catch(() => {});
    await store.close();
    await log.close();
  });
  const subject = new ServiceStartup({
    resources,
    store,
    log,
    config: readConfig({ ACE_HOME: "/unused", ACE_PORT: "0" }),
    options: {},
    signal: new AbortController().signal,
    now: () => time,
    id: () => "id",
    services: {},
    onListen: [],
  });
  const Line = z.object({ message: z.string(), data: z.unknown() });
  const line = (message: string) =>
    log
      .recent()
      .map((text) => Line.parse(JSON.parse(text)))
      .find((record) => record.message === message)?.data;
  return { subject, line, advance: (ms: number) => void (time += ms) };
}

function service(
  name: string,
  phase: ServiceDefinition["phase"],
  start: ServiceDefinition["start"],
): ServiceDefinition {
  return { name, phase, requires: [], after: [], start };
}

test("a start logs one line per phase naming each service and how long its own start took", async () => {
  const { subject, line, advance } = startup();
  await subject.start([
    service("settings", "core", () => advance(3)),
    service("engine", "core", () => advance(120)),
    service("browser", "core", () => {
      advance(7);
      throw new Error("Chromium missing");
    }),
    service("market", "listener", () => advance(40)),
  ]);
  expect(line("Core services started")).toEqual({
    durationMs: 130,
    services: "settings 3ms, engine 120ms, browser 7ms (degraded)",
  });
  expect(line("Listener services started")).toBeUndefined();

  await subject.listening(server);
  expect(line("Listener services started")).toEqual({
    durationMs: 40,
    services: "core listeners 0ms, market 40ms",
  });
});
