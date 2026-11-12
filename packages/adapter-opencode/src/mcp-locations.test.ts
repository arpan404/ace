import { expect, test } from "vitest";
import type { OpenCodeClient } from "@opencode/client";
import { AceMcpLocations } from "./mcp-locations.ts";
import { runtime } from "./runtime.ts";

type Location = { location: { directory: string } };
const unavailable = { type: "rpc.unavailable", message: "RPC is unavailable: ace.mcp.readiness" };
const ready = { tools: [{ name: "ace_context", description: "What ace already knows" }] };

/**
 * OpenCode's location-scoped MCP API in memory, as 2.2.x answers it: a second `add` of a name
 * a location already has is the collision ace guards against.
 */
function opencode(
  options: {
    own?: string[];
    /** Runs before OpenCode answers a list or performs an add, so a test can hold it open. */
    list?: () => Promise<void> | void;
    add?: () => Promise<void> | void;
    connect?: () => void;
    readiness?: () => unknown | Promise<unknown>;
  } = {},
) {
  const servers = new Map<string, Set<string>>();
  for (const directory of options.own ?? []) servers.set(directory, new Set(["ace"]));
  let adds = 0;
  const client = {
    mcp: {
      async list({ location }: Location) {
        await Promise.resolve();
        await options.list?.();
        return {
          data: [...(servers.get(location.directory) ?? [])].map((name) => ({
            name,
            status: { status: "connected" },
          })),
        };
      },
      async add({ location, server }: Location & { server: string }) {
        await Promise.resolve();
        await options.add?.();
        const names = servers.get(location.directory) ?? new Set<string>();
        if (names.has(server)) throw new Error(`MCP server already exists: ${server}`);
        names.add(server);
        servers.set(location.directory, names);
        adds += 1;
      },
      async connect() {
        options.connect?.();
      },
    },
    rpc: () => ({
      async ready() {
        const reply = (await options.readiness?.()) ?? ready;
        if (typeof reply === "object" && reply && "type" in reply) throw reply;
        return reply;
      },
    }),
  };
  // Only the MCP and readiness RPC routes are reachable from AceMcpLocations.
  return {
    client: client as unknown as OpenCodeClient,
    adds: () => adds,
    /** OpenCode's location.shutdown: runtime MCP servers are gone (2.2.6 eviction). */
    rebuild: (directory: string) => servers.delete(directory),
    /** The person's own server named ace, from their configuration. */
    own: (directory: string) => servers.set(directory, new Set(["ace"])),
  };
}
/** Pauses run at once and advance the clock by their length. */
function stepped() {
  let now = 0;
  return runtime({
    monotonic: () => now,
    schedule(callback, delay) {
      if (delay >= 10_000) return () => {};
      now += delay;
      queueMicrotask(callback);
      return () => {};
    },
  });
}
function locations(fake: ReturnType<typeof opencode>) {
  const warnings: string[] = [];
  const subject = new AceMcpLocations({
    client: fake.client,
    connection: { url: "http://127.0.0.1:9/mcp", bearer: "a".repeat(64) },
    runtime: stepped(),
    unconfirmed: () => warnings.push("unconfirmed"),
  });
  return { subject, warnings };
}

test("a send and an interaction answer for the same new location add ace's server once and both go ahead", async () => {
  const fake = opencode();
  const { subject } = locations(fake);
  await expect(
    Promise.all([subject.admit("/one"), subject.ensure("/one"), subject.ensure("/one")]),
  ).resolves.toBeDefined();
  expect(fake.adds()).toBe(1);
});

test("after ace's server was added but could not connect, the next send connects it without a name collision", async () => {
  let connects = 0;
  const fake = opencode({
    connect() {
      if (++connects === 1) throw new Error("connect timed out");
    },
  });
  const { subject } = locations(fake);
  await expect(subject.ensure("/one")).rejects.toThrow("connect timed out");
  await expect(subject.admit("/one")).resolves.toBeUndefined();
  expect(fake.adds()).toBe(1);
});

test("after readiness failed once, the next send checks again on ace's own server", async () => {
  let checks = 0;
  const fake = opencode({ readiness: () => (++checks === 1 ? { tools: [] } : ready) });
  const { subject, warnings } = locations(fake);
  await expect(subject.ensure("/one")).rejects.toThrow("ace context tool is missing");
  await expect(subject.admit("/one")).resolves.toBeUndefined();
  expect(warnings).toEqual([]);
});

test("a server the person named ace is still refused, every time", async () => {
  const fake = opencode({ own: ["/one"] });
  const { subject } = locations(fake);
  await expect(subject.ensure("/one")).rejects.toThrow("OpenCode MCP server name collision: ace");
  await expect(subject.admit("/one")).rejects.toThrow("OpenCode MCP server name collision: ace");
  expect(fake.adds()).toBe(0);
});

test("unconfirmed tools warn once and are confirmed by a later send once the plugin answers", async () => {
  let plugin: "loading" | "registered" | "broken" = "loading";
  const fake = opencode({
    readiness: () => ({ loading: unavailable, registered: ready, broken: { tools: [] } })[plugin],
  });
  const { subject, warnings } = locations(fake);
  await subject.admit("/one");
  await subject.admit("/one");
  expect(warnings).toEqual(["unconfirmed"]);
  // Still unconfirmed, so each send looks again: a plugin that now answers wrongly fails it.
  plugin = "broken";
  await expect(subject.admit("/one")).rejects.toThrow("ace context tool is missing");
  plugin = "registered";
  await subject.admit("/one");
  // Confirmed now, so no further check runs: a plugin answering wrongly would otherwise fail.
  plugin = "broken";
  await expect(subject.admit("/one")).resolves.toBeUndefined();
  expect(warnings).toEqual(["unconfirmed"]);
  expect(fake.adds()).toBe(1);
});

test("new locations set up together cannot pass the 128-location limit", async () => {
  const fake = opencode();
  const { subject } = locations(fake);
  const results = await Promise.allSettled(
    Array.from({ length: 130 }, (_, index) => subject.ensure(`/dir-${index}`)),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(128);
  expect(results.filter((result) => result.status === "rejected")).toEqual([
    { status: "rejected", reason: new Error("OpenCode MCP location limit exceeded") },
    { status: "rejected", reason: new Error("OpenCode MCP location limit exceeded") },
  ]);
});

test("after OpenCode rebuilds a location, the next send adds ace's server there again", async () => {
  const fake = opencode();
  const { subject } = locations(fake);
  await subject.admit("/one");
  fake.rebuild("/one");
  subject.forget("/one");
  await subject.admit("/one");
  expect(fake.adds()).toBe(2);
});

test("a server ace added but never connected is added again after a rebuild, not connected blind", async () => {
  let connects = 0;
  const fake = opencode({
    connect() {
      if (++connects === 1) throw new Error("connect timed out");
    },
  });
  const { subject } = locations(fake);
  await expect(subject.ensure("/one")).rejects.toThrow("connect timed out");
  fake.rebuild("/one");
  subject.forget("/one");
  await subject.admit("/one");
  expect(fake.adds()).toBe(2);
});

test("a server the person named ace that appears after a rebuild is refused, not taken for ace's", async () => {
  const fake = opencode({
    connect() {
      throw new Error("connect timed out");
    },
  });
  const { subject } = locations(fake);
  await expect(subject.ensure("/one")).rejects.toThrow("connect timed out");
  fake.rebuild("/one");
  fake.own("/one");
  subject.forget("/one");
  await expect(subject.admit("/one")).rejects.toThrow("OpenCode MCP server name collision: ace");
});

test("a set-up still running when the location is rebuilt records nothing, and the send sets ace up again", async () => {
  const held = Promise.withResolvers<void>();
  let checks = 0;
  // The first readiness answer waits until the rebuild has happened.
  const fake = opencode({
    async readiness() {
      if (++checks === 1) await held.promise;
      return ready;
    },
  });
  const { subject } = locations(fake);
  const sending = subject.admit("/one");
  await new Promise((resolve) => setTimeout(resolve, 0));
  fake.rebuild("/one");
  subject.forget("/one");
  held.resolve();
  await sending;
  expect(fake.adds()).toBe(2);
});

/** Resolves once `hold` has been reached, and lets the held call go on with `release`. */
function gate() {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let first = true;
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    async hold() {
      if (!first) return;
      first = false;
      reached.resolve();
      await released.promise;
    },
  };
}

test("a set-up whose listing straddles a rebuild adds nothing stale, so ace's server is added once", async () => {
  const listing = gate();
  const fake = opencode({ list: listing.hold });
  const { subject } = locations(fake);
  const sending = subject.admit("/one");
  await listing.reached;
  fake.rebuild("/one");
  subject.forget("/one");
  listing.release();
  await sending;
  expect(fake.adds()).toBe(1);
});

test("an ace server ace cannot prove it added in the rebuilt location is refused, never adopted", async () => {
  const adding = gate();
  const fake = opencode({ add: adding.hold });
  const { subject } = locations(fake);
  const sending = subject.admit("/one");
  await adding.reached;
  // OpenCode rebuilds while the add is in flight; the add then reaches the new services, where
  // nothing tells ace's server apart from one the person configured.
  fake.rebuild("/one");
  subject.forget("/one");
  adding.release();
  await expect(sending).rejects.toThrow("OpenCode MCP server name collision: ace");
});
