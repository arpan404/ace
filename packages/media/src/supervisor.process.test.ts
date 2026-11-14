import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { encodeMediaFrame, type MediaFrame } from "./frame.ts";
import { authenticateLane, connectLane } from "./lanes.ts";
import {
  legacyMediaSettings,
  MediaSupervisor,
  nodeMediaHost,
  systemMediaClock,
  type MediaExit,
} from "./supervisor.ts";
import type { FromMedia } from "./wire.ts";

// A real child and a real control socket: spawning, stdio framing under real pipe
// backpressure, socket lane authentication and the priority lane can't be covered by the
// in-memory fakes of supervisor.test.ts.
//
// By default the child is a TypeScript stand-in. With ACE_MEDIA_TEST_BINARY set to a built
// ace-media (`cargo build -p ace-media` in native/media), the same tests drive the real binary,
// and so does the crash-and-replay test, which needs a real ingest socket.
const real = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;
const fake = fileURLToPath(new URL("./__fixtures__/fake-ace-media.ts", import.meta.url));
const target = real
  ? {
      binary: real,
      version: execFileSync(real, ["--version"]).toString().trim(),
      launch: (binary: string) => ({ command: binary, args: [] }),
    }
  : {
      binary: fake,
      version: "0.0.0-test",
      launch: (script: string) => ({ command: process.execPath, args: [script] }),
    };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type Hooks = {
  replay?: (supervisor: MediaSupervisor) => void;
  onMessage?: (message: FromMedia) => void;
};

function start(env: NodeJS.ProcessEnv = {}, hooks: Hooks = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ace-media-"));
  const exits: MediaExit[] = [];
  const state = { replays: 0, egress: 0 };
  const supervisor: MediaSupervisor = new MediaSupervisor({
    version: target.version,
    binary: target.binary,
    runtimeDir,
    dataDir: runtimeDir,
    settings: () => ({ ...legacyMediaSettings, stills: "auto" }),
    host: nodeMediaHost({ ...process.env, ...env }, target.launch),
    clock: systemMediaClock,
    random: Math.random,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    replay: () => {
      state.replays++;
      hooks.replay?.(supervisor);
    },
    onMessage: (message) => hooks.onMessage?.(message),
    onEgress: () => void state.egress++,
    onExit: (exit) => void exits.push(exit),
    log: () => {},
  });
  cleanups.push(() => {
    supervisor.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  const control = () => {
    const pid = supervisor.snapshot().pid;
    if (real) return join(runtimeDir, `m${pid}c.sock`);
    return process.platform === "win32"
      ? `\\\\.\\pipe\\ace-media-fake-${pid}`
      : join(runtimeDir, "control.sock");
  };
  return { supervisor, exits, state, control };
}

it("supervises a process that speaks the control protocol: lanes up, revocation answered, killed on dispose", async () => {
  const { supervisor, exits, state, control } = start();
  supervisor.need();
  await until(() => supervisor.health() === "healthy");
  expect(state.replays).toBe(1);
  expect(supervisor.snapshot().pid).toBeGreaterThan(0);

  // Another process can't take a lane over: without the secret, and with both lanes taken, it is
  // refused, and the supervisor's own lanes stay up.
  for (const lane of ["priority", "egress"] as const) {
    const intruder = await connectLane(control());
    await expect(
      authenticateLane(intruder, lane, new Uint8Array(randomBytes(32))),
    ).rejects.toThrow();
    intruder.destroy();
  }

  const started = performance.now();
  expect(await supervisor.revoke({ type: "revoke", id: "r1", issued: 1, device: "d1" })).toBe(
    "answered",
  );
  expect(performance.now() - started).toBeLessThan(250);
  expect(supervisor.health()).toBe("healthy");

  supervisor.dispose();
  await until(() => exits.length === 1);
  expect(exits[0]).toMatchObject({ cause: "disposed", failure: false });
});

it("answers revocations well inside the deadline while the normal lane is saturated", async () => {
  // The stand-in also keeps the egress lane full; the real binary's egress is idle until G1.
  const { supervisor, state } = start({ FAKE_MEDIA_EGRESS_FLOOD: "1" });
  supervisor.need();
  await until(
    () => supervisor.health() === "healthy" && (real !== undefined || state.egress >= 64),
  );
  const picture = { type: "source.picture", source: "s1", ageMs: 0, epoch: 0 } as const;
  const latencies: number[] = [];
  for (let i = 0; i < 40; i++) {
    // Keep 8 MiB of pictures ahead of every revocation on the normal lane.
    for (let j = 0; j < 8; j++) supervisor.send(picture, new Uint8Array(1024 * 1024));
    const started = performance.now();
    expect(await supervisor.revoke({ type: "revoke", id: `r${i}`, issued: i, device: "d1" })).toBe(
      "answered",
    );
    latencies.push(performance.now() - started);
  }
  latencies.sort((a, b) => a - b);
  const p99 = latencies[Math.ceil(latencies.length * 0.99) - 1] ?? Infinity;
  // The plan's bound for ace-media is 50 ms p99; the stand-in only has to beat the kill.
  expect(p99, `p99 revocation ${p99.toFixed(1)} ms`).toBeLessThan(real ? 50 : 250);
  if (!real) expect(state.egress).toBeGreaterThan(64);
  expect(supervisor.health()).toBe("healthy");
});

function unit(kind: number, payload: Uint8Array): Uint8Array {
  const frame: MediaFrame = {
    kind,
    flags: kind === 1 ? 1 : 0,
    ageUs: 0,
    width: 2,
    height: 2,
    displayWidth: 2,
    displayHeight: 2,
    scale: 1000,
    rotation: 0,
    codec: kind === 5 ? 0 : 1,
    encode: 0,
    epoch: 1,
    codecString: "",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
    payload,
  };
  return encodeMediaFrame(frame);
}

/** A producer: the hello with its token, then a unit every 20 ms until its socket closes. */
function produce(socketPath: string, token: Uint8Array): () => void {
  const socket = createConnection(socketPath);
  socket.on("error", () => {});
  socket.write(unit(5, token));
  const timer = setInterval(() => socket.write(unit(1, new Uint8Array(1024))), 20);
  socket.once("close", () => clearInterval(timer));
  const stop = () => {
    clearInterval(timer);
    socket.destroy();
  };
  cleanups.push(stop);
  return stop;
}

it.runIf(real)(
  "restarts the real binary after kill -9 within backoff, replays its source, and the producer plays again",
  async () => {
    const statuses: string[] = [];
    let handle = 0;
    let token = new Uint8Array(0);
    const { supervisor, exits } = start(
      {},
      {
        // The daemon's state is the truth: every start reopens the source with a fresh token.
        replay(media) {
          token = new Uint8Array(randomBytes(32));
          const origin = { kind: "tab" } as const;
          media.send(
            { type: "source.open", source: "s1", handle: ++handle, epoch: 1, origin },
            token.slice(),
          );
        },
        onMessage(message) {
          if (message.type === "source.status") statuses.push(message.status);
        },
      },
    );
    supervisor.need();
    await until(() => statuses.includes("starting"));
    const first = supervisor.ingest();
    expect(first).toBeDefined();
    produce(first?.socket ?? "", token);
    await until(() => statuses.at(-1) === "playing");

    const pid = supervisor.snapshot().pid ?? 0;
    statuses.length = 0;
    const killed = performance.now();
    process.kill(pid, "SIGKILL");
    await until(() => exits.length === 1);
    expect(exits[0]).toMatchObject({ failure: true, sources: ["s1"] });
    const backoff = exits[0]?.restartInMs ?? Infinity;
    expect(backoff).toBeLessThanOrEqual(600);

    await until(() => supervisor.health() === "healthy" && supervisor.snapshot().pid !== pid);
    expect(performance.now() - killed).toBeLessThan(backoff + 3_000);
    const second = supervisor.ingest();
    expect(second?.socket).not.toBe(first?.socket);
    await until(() => statuses.includes("starting"));
    produce(second?.socket ?? "", token);
    await until(() => statuses.at(-1) === "playing");
    expect(statuses).toEqual(["starting", "playing"]);
  },
);
