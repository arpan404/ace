import { expect, test } from "vitest";
import type { SpadeStatus } from "@ace/protocol";
import { SpadeHost, type SpadeExit, type SpadeHostRuntime } from "./host.ts";

const pollMs = 7;
const dataDir = "/ace/spade";
class FakeChild {
  readonly pid: number;
  readonly env: Record<string, string>;
  readonly exited: Promise<SpadeExit>;
  stoppedWith: number | undefined;
  private finish!: (exit: SpadeExit) => void;
  constructor(pid: number, env: Record<string, string>) {
    this.pid = pid;
    this.env = env;
    this.exited = new Promise((resolve) => (this.finish = resolve));
  }
  exit(exit: SpadeExit) {
    this.finish(exit);
  }
  stop(graceMs: number) {
    this.stoppedWith = graceMs;
    this.exit({ code: null, signal: "SIGTERM" });
    return this.exited;
  }
}

/**
 * A runtime where Spade behaves as the contract says unless told otherwise: each child writes
 * its `server.json` and token on its first poll. Every poll moves the clock a second; restart
 * waits are held until `release`.
 */
function harness(options: { binary?: string | undefined; writesServerFile?: boolean } = {}) {
  const files = new Map<string, string>();
  const children: FakeChild[] = [];
  const restarts: number[] = [];
  const held: (() => void)[] = [];
  const statuses: SpadeStatus[] = [];
  let revoked = 0;
  let issued = 0;
  let clock = 0;
  const runtime: SpadeHostRuntime = {
    spawn({ env }) {
      const child = new FakeChild(100 + children.length, env);
      children.push(child);
      return child;
    },
    async readText(path) {
      const child = children.at(-1);
      if (child && options.writesServerFile !== false && path.endsWith("server.json")) {
        files.set(`${dataDir}/token`, "t".repeat(64));
        files.set(
          `${dataDir}/server.json`,
          JSON.stringify({ address: "127.0.0.1:4100", pid: child.pid, version: "0.1.0" }),
        );
      }
      return files.get(path);
    },
    ensureDirectory: () => {},
    healthy: async () => true,
    now: () => clock,
    sleep(ms, signal) {
      if (ms === pollMs) {
        clock += 1000;
        return new Promise((resolve) => setImmediate(resolve));
      }
      restarts.push(ms);
      return new Promise((resolve) => {
        held.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  const host = new SpadeHost({
    dataDir,
    binary: () => ("binary" in options ? options.binary : "/bin/spade-server"),
    credentials: async () => {
      issued++;
      return {
        env: { SPADE_ACE_MCP_TOKEN: `lease-${issued}` },
        revoke: () => revoked++,
      };
    },
    runtime,
    log: () => {},
    pollMs,
  });
  host.subscribe((status) => statuses.push(status));
  return {
    host,
    files,
    children,
    restarts,
    statuses,
    revoked: () => revoked,
    advance: (ms: number) => (clock += ms),
    release: () => held.splice(0).forEach((resolve) => resolve()),
  };
}
async function eventually(check: () => boolean) {
  for (let turn = 0; turn < 500 && !check(); turn++)
    await new Promise((resolve) => setImmediate(resolve));
  expect(check()).toBe(true);
}

test("without a binary Spade stays off and says why", async () => {
  const h = harness({ binary: undefined });
  h.host.setEnabled(true);
  await eventually(() => h.statuses.length > 0);
  expect(h.host.status()).toEqual({
    state: "off",
    reason: "Spade isn't installed: no spade-server binary was found.",
  });
  expect(h.children).toHaveLength(0);
});

test("Spade starts with its data directory, a loopback listener and a fresh lease", async () => {
  const h = harness();
  h.host.setEnabled(true);
  await eventually(() => h.host.status().state === "ready");
  expect(h.statuses.map((status) => status.state)).toEqual(["starting", "ready"]);
  expect(h.host.status().version).toBe("0.1.0");
  expect(h.children[0]?.env).toEqual({
    SPADE_ACE_MCP_TOKEN: "lease-1",
    SPADE_DATA_DIR: dataDir,
    SPADE_LISTEN: "127.0.0.1:0",
    RUST_LOG: "info",
  });
  expect(h.host.ready()?.connection).toEqual({
    host: "127.0.0.1",
    port: 4100,
    token: "t".repeat(64),
  });
  await h.host.close();
});

test("a server.json left by an earlier Spade is not taken as ready", async () => {
  const h = harness({ writesServerFile: false });
  h.files.set(`${dataDir}/token`, "t".repeat(64));
  h.files.set(
    `${dataDir}/server.json`,
    JSON.stringify({ address: "127.0.0.1:4000", pid: 99, version: "0.0.9" }),
  );
  h.host.setEnabled(true);
  await eventually(() => h.children.length === 1);
  for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
  expect(h.host.status().state).toBe("starting");
  h.files.set(
    `${dataDir}/server.json`,
    JSON.stringify({ address: "127.0.0.1:4100", pid: 100, version: "0.1.0" }),
  );
  await eventually(() => h.host.status().state === "ready");
  expect(h.host.ready()?.connection.port).toBe(4100);
  await h.host.close();
});

test("crashes are reported and restarted after 1, 2 and 4 s, each run with its own lease", async () => {
  const h = harness();
  h.host.setEnabled(true);
  for (let crash = 1; crash <= 3; crash++) {
    await eventually(() => h.host.status().state === "ready" && h.children.length === crash);
    h.children.at(-1)?.exit({ code: 1, signal: null });
    await eventually(() => h.restarts.length === crash);
    expect(h.host.status()).toEqual({ state: "failed", reason: "Spade exited with code 1." });
    expect(h.host.ready()).toBeUndefined();
    expect(h.revoked()).toBe(crash);
    h.release();
  }
  expect(h.restarts).toEqual([1000, 2000, 4000]);
  await eventually(() => h.children.length === 4);
  expect(h.children.map((child) => child.env.SPADE_ACE_MCP_TOKEN)).toEqual([
    "lease-1",
    "lease-2",
    "lease-3",
    "lease-4",
  ]);
  await h.host.close();
});

test("after a run that stayed up a minute, the next restart waits 1 s again", async () => {
  const h = harness();
  h.host.setEnabled(true);
  for (let crash = 1; crash <= 2; crash++) {
    await eventually(() => h.host.status().state === "ready" && h.children.length === crash);
    h.children.at(-1)?.exit({ code: 1, signal: null });
    await eventually(() => h.restarts.length === crash);
    h.release();
  }
  await eventually(() => h.host.status().state === "ready" && h.children.length === 3);
  h.advance(60_000);
  h.children.at(-1)?.exit({ code: 1, signal: null });
  await eventually(() => h.restarts.length === 3);
  expect(h.restarts).toEqual([1000, 2000, 1000]);
  await h.host.close();
});

test("a Spade that never becomes ready is stopped after 15 s and retried", async () => {
  const h = harness({ writesServerFile: false });
  h.host.setEnabled(true);
  await eventually(() => h.restarts.length === 1);
  expect(h.children[0]?.stoppedWith).toBe(5000);
  expect(h.host.status()).toEqual({
    state: "failed",
    reason: "Spade didn't become ready within 15 s.",
  });
  await h.host.close();
});

test("turning Spade off ends its streams, stops it with a 5 s grace and revokes its lease", async () => {
  const h = harness();
  const ended: number[] = [];
  h.host.onRunEnded((generation) => ended.push(generation));
  h.host.setEnabled(true);
  await eventually(() => h.host.status().state === "ready");
  const generation = h.host.ready()?.generation;
  h.host.setEnabled(false);
  await eventually(() => h.host.status().state === "off");
  expect(ended).toEqual([generation]);
  expect(h.children[0]?.stoppedWith).toBe(5000);
  expect(h.revoked()).toBe(1);
  expect(h.restarts).toEqual([]);
  // On again: a new run, a new generation.
  h.host.setEnabled(true);
  await eventually(() => h.host.status().state === "ready");
  expect(h.children).toHaveLength(2);
  expect(h.host.ready()?.generation).not.toBe(generation);
  await h.host.close();
  expect(h.host.status().state).toBe("off");
});
