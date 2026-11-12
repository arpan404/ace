import { expect, test } from "vitest";
import { ThreadId, type SpadeStatus } from "@ace/protocol";
import { SpadeLink } from "./link.ts";
import { spadeProof } from "@ace/service/spade";
import { spadeStartGraceMs, type SpadeServiceState } from "./rules.ts";

/** A machine with a service manager, Spade's files and a clock, all under the test's control. */
function machine() {
  const files = new Map<string, string>();
  const world = {
    service: "absent" as SpadeServiceState,
    /**
     * Ports whose `/health` answers `ok`, with the key each proves nonces with: a Spade proves
     * with its token file's token; null answers with no proof at all.
     */
    answering: new Map<number, string | null>(),
    /** Pids of running processes. */
    alive: new Set<number>(),
    now: 0,
    files,
    watched: undefined as (() => void) | undefined,
    nonces: 1,
    /** What `/health` says Spade is still setting up, if anything. */
    setup: undefined as string | undefined,
  };
  const link = new SpadeLink({
    dataDir: "/ace/spade",
    runtime: {
      readText: async (path) => files.get(path),
      health: async (endpoint, nonce) => {
        const key = world.answering.get(endpoint.port);
        if (key === undefined) return undefined;
        return {
          version: "0.4.0",
          api: 1,
          proof: key === null ? undefined : spadeProof(key, nonce),
          setup: world.setup,
        };
      },
      alive: (pid) => world.alive.has(pid),
      nonce: () => (world.nonces++).toString(16).padStart(32, "0"),
      serviceState: async () => world.service,
      watch: (_directory, changed) => {
        world.watched = changed;
        return () => {
          world.watched = undefined;
        };
      },
      now: () => world.now,
      platform: "darwin",
      after: () => () => {},
    },
  });
  const seen: SpadeStatus[] = [];
  link.subscribe((status) => seen.push(status));
  /** Spade starts: token, then server.json, as the contract orders them. */
  const spadeStarts = (pid: number, port: number, version = "0.4.0") => {
    const token = `token-for-${pid}-xxxxxxxx`;
    files.set("/ace/spade/token", token);
    files.set(
      "/ace/spade/server.json",
      JSON.stringify({ address: `127.0.0.1:${port}`, pid, version, api: 1 }),
    );
    world.alive.add(pid);
    world.answering.set(port, token);
  };
  return { link, world, seen, spadeStarts, state: () => link.status().state };
}

test("spade.status reads off, starting, ready and failed from the registration and Spade's files", async () => {
  const { link, world, spadeStarts, state } = machine();
  // Turned off: off, whatever is registered.
  world.service = "running";
  await link.refresh();
  expect(link.status()).toEqual({ state: "off" });

  // Turned on with no service registered: still off, saying why.
  world.service = "absent";
  link.setEnabled(true);
  await link.refresh();
  expect(link.status()).toMatchObject({
    state: "off",
    reason: expect.stringContaining("isn't registered"),
  });

  // Registered and running, not yet listening: starting.
  world.service = "running";
  await link.refresh();
  expect(state()).toBe("starting");

  // server.json appears and /health answers: ready, with Spade's version.
  spadeStarts(41, 4100);
  world.watched?.();
  await link.refresh();
  expect(link.status()).toEqual({ state: "ready", version: "0.4.0" });
  expect(link.ready()?.connection).toEqual({
    host: "127.0.0.1",
    port: 4100,
    token: "token-for-41-xxxxxxxx",
  });

  // Spade stops answering but stays registered: starting, then failed past the grace period.
  world.answering.clear();
  await link.refresh();
  expect(state()).toBe("starting");
  expect(link.ready()).toBeUndefined();
  world.now += spadeStartGraceMs;
  await link.refresh();
  expect(link.status()).toMatchObject({
    state: "failed",
    reason: expect.stringContaining("isn't answering"),
  });

  // The service manager has it stopped: failed, saying so.
  world.service = "stopped";
  await link.refresh();
  expect(link.status()).toMatchObject({
    state: "failed",
    reason: expect.stringContaining("not running"),
  });

  // Turned off again: off, and the files are no longer watched.
  link.setEnabled(false);
  await link.refresh();
  expect(link.status()).toEqual({ state: "off" });
  expect(world.watched).toBeUndefined();
});

test("each Spade that answers is a new instance: streams to the last one end and arrivals are told", async () => {
  const { link, world, spadeStarts } = machine();
  const ended: number[] = [];
  const arrived: number[] = [];
  link.onRunEnded((generation) => ended.push(generation));
  link.onReady((ready) => arrived.push(ready.connection.port));
  world.service = "running";
  link.setEnabled(true);
  spadeStarts(41, 4100);
  await link.refresh();
  const first = link.ready()?.generation;
  expect(arrived).toEqual([4100]);

  // Looking again at the same Spade changes nothing.
  await link.refresh();
  expect(link.ready()?.generation).toBe(first);
  expect(ended).toEqual([]);

  // Restarted by its service manager on another port: the old instance ends, the new arrives.
  world.answering.clear();
  spadeStarts(42, 4200);
  await link.refresh();
  expect(ended).toEqual([first]);
  expect(arrived).toEqual([4100, 4200]);
  expect(link.ready()?.generation).not.toBe(first);

  // A failed turn-on is reported even with an old Spade answering.
  link.setSwitch({ problem: "Spade couldn't be registered as a service: no binary" });
  await link.refresh();
  expect(link.status()).toMatchObject({
    state: "failed",
    reason: expect.stringContaining("no binary"),
  });
});

test("a Spade still waiting for the keychain is ready and says so until it is done", async () => {
  const { link, world, seen, spadeStarts } = machine();
  world.service = "running";
  link.setEnabled(true);
  spadeStarts(41, 4100);
  world.setup = "waiting for the keychain";
  await link.refresh();
  expect(link.status()).toEqual({
    state: "ready",
    version: "0.4.0",
    setup: { reason: "waiting for the keychain", platform: "darwin" },
  });
  world.setup = undefined;
  await link.refresh();
  expect(link.status()).toEqual({ state: "ready", version: "0.4.0" });
  expect(seen.at(-1)).toEqual({ state: "ready", version: "0.4.0" });
});

test("the host thread rides along with every status, on or off", async () => {
  const { link, seen } = machine();
  link.setThread({ id: ThreadId.parse("thread-spade"), busy: true });
  expect(link.status()).toEqual({ state: "off", thread: { id: "thread-spade", busy: true } });
  expect(seen.at(-1)).toEqual(link.status());
});

test("nothing but the registered, running Spade that proves its token is ready or handed anything", async () => {
  const { link, world, spadeStarts } = machine();
  const arrived: number[] = [];
  link.onReady((ready) => arrived.push(ready.connection.port));
  world.service = "running";
  link.setEnabled(true);
  spadeStarts(41, 4100);

  // Another program now listens at server.json's port: it answers ok but can't prove the token.
  for (const impostor of [null, "some-other-key-xxxxxxxx"]) {
    world.answering.set(4100, impostor);
    await link.refresh();
    expect(link.status()).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("can't prove it is Spade"),
    });
    expect(link.ready()).toBeUndefined();
  }

  // server.json's pid is gone, though its port answers as Spade did: not ready.
  spadeStarts(41, 4100);
  world.alive.delete(41);
  await link.refresh();
  expect(link.ready()).toBeUndefined();
  expect(link.status().state).toBe("starting");

  // A Spade proving itself, while the service is stopped or not registered: not ready either.
  world.alive.add(41);
  for (const service of ["stopped", "absent"] as const) {
    world.service = service;
    await link.refresh();
    expect(link.ready()).toBeUndefined();
    expect(link.status().state).toBe(service === "stopped" ? "failed" : "off");
  }
  expect(arrived).toEqual([]);

  // Registered and running again: now it is Spade, and only now is it told of.
  world.service = "running";
  await link.refresh();
  expect(link.status()).toEqual({ state: "ready", version: "0.4.0" });
  expect(arrived).toEqual([4100]);
});
