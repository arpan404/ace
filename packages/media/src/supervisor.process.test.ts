import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { relayHost } from "./lane-relay-test-support.ts";
import { removeWhenFree } from "./supervisor-test-support.ts";
import { encodeMediaFrame, type MediaFrame } from "./frame.ts";
import { authenticateLane, connectLane } from "./lanes.ts";
import {
  legacyMediaSettings,
  MediaSupervisor,
  nodeMediaHost,
  systemMediaClock,
  type MediaExit,
  type MediaHost,
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

const nonce = (length: number) => new Uint8Array(randomBytes(length));

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
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
  /** The lane secret, instead of the CSPRNG's. */
  randomBytes?: (length: number) => Uint8Array;
  /** Wraps the real host. */
  host?: (host: MediaHost) => MediaHost;
};

function start(env: NodeJS.ProcessEnv = {}, hooks: Hooks = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ace-media-"));
  const exits: MediaExit[] = [];
  const state = { replays: 0, egress: 0 };
  // The control socket the supervisor dialled for its lanes, as ace-media named it in `ready`.
  let dialled: string | undefined;
  const remember = (host: MediaHost): MediaHost => ({
    spawn: (binary) => host.spawn(binary),
    connect: (path) => {
      dialled = path;
      return host.connect(path);
    },
  });
  const supervisor: MediaSupervisor = new MediaSupervisor({
    version: target.version,
    binary: target.binary,
    runtimeDir,
    dataDir: runtimeDir,
    settings: () => ({ ...legacyMediaSettings, stills: "auto" }),
    host: remember(
      (hooks.host ?? ((host) => host))(nodeMediaHost({ ...process.env, ...env }, target.launch)),
    ),
    ...(hooks.randomBytes ? { randomBytes: hooks.randomBytes } : {}),
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
  cleanups.push(async () => {
    supervisor.dispose();
    await removeWhenFree(runtimeDir);
  });
  const control = () => {
    const pid = supervisor.snapshot().pid;
    // The binary names its control socket itself in `ready` (`m<pid>c.sock`, or a named pipe
    // with a nonce on Windows): the one the supervisor dialled, known before both lanes are up.
    // `supervisor.ingest()` is not it: that stays empty until the process accepts producers.
    if (real) {
      if (!dialled)
        throw new Error("The supervisor has not dialled ace-media's control socket yet");
      return dialled;
    }
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
      authenticateLane(intruder, lane, new Uint8Array(randomBytes(32)), nonce),
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

it("a squatting server that doesn't hold the lane secret gets the hello's nonce and nothing else", async () => {
  // Any process of this user can open another instance of a Windows pipe name (or here, any
  // socket the daemon is pointed at): it answers the hello, but can't prove the secret.
  const secret = new Uint8Array(randomBytes(32));
  const squatter = createServer();
  const received: Buffer[] = [];
  let closed = false;
  squatter.on("connection", (socket) => {
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => (closed = true));
    // A guess at a proof, and a nonce.
    socket.write(randomBytes(64));
  });
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\ace-media-squat-${process.pid}-${randomBytes(4).toString("hex")}`
      : join(mkdtempSync(join(tmpdir(), "ace-squat-")), "c.sock");
  await new Promise<void>((resolve) => squatter.listen(address, resolve));
  cleanups.push(() => void squatter.close());
  const lane = await connectLane(address);
  await expect(authenticateLane(lane, "priority", secret, nonce)).rejects.toThrow(/did not prove/);
  lane.destroy();
  // Everything the squatter ever got, up to the connection's close.
  await until(() => closed);
  const bytes = Buffer.concat(received);
  // Only the hello: magic, tag and a nonce. No secret, and no proof derived from it.
  expect(bytes.length).toBe(37);
  expect(bytes.subarray(0, 5)).toEqual(Buffer.from([0x41, 0x43, 0x45, 0x4c, 1]));
  expect(bytes.includes(Buffer.from(secret))).toBe(false);
});

/** `chunk` with the byte at `at` changed, when it falls in this chunk. */
function flipped(chunk: Buffer, before: number, at: number): Buffer {
  if (at < before || at >= before + chunk.length) return chunk;
  const copy = Buffer.from(chunk);
  copy[at - before] = (copy[at - before] ?? 0) ^ 0x01;
  return copy;
}

// The daemon's hello and proof, then its first record; ace-media's reply, then its accept record.
const helloAndProof = 37 + 32;
const replyAndAccept = 64 + 2 + 17;

it.runIf(real)(
  "a relay that passes the hello through and then changes one byte the daemon sends gets the lane closed, never the frame accepted",
  async () => {
    let relay: ReturnType<typeof relayHost> | undefined;
    const { supervisor, exits } = start(
      {},
      {
        // Inside the first record on the priority lane (its length is the first two bytes).
        host: (host) =>
          (relay = relayHost(host, (lane, direction, chunk, before) =>
            lane === 0 && direction === "toMedia"
              ? flipped(chunk, before, helloAndProof + 4)
              : chunk,
          )).host,
      },
    );
    cleanups.push(() => relay?.close());
    supervisor.need();
    await until(() => supervisor.health() === "healthy");
    // The revocation's record is the one changed: ace-media refuses it and ends the lane.
    expect(await supervisor.revoke({ type: "revoke", id: "r1", issued: 1, device: "d1" })).not.toBe(
      "answered",
    );
    await until(() => exits.length > 0);
    // The next process's lanes are relayed unchanged, and work.
    await until(() => supervisor.health() === "healthy");
    expect(await supervisor.revoke({ type: "revoke", id: "r2", issued: 2, device: "d1" })).toBe(
      "answered",
    );
  },
);

it.runIf(real)(
  "a relay that injects a record of its own on the egress lane gets the lane closed",
  async () => {
    let relay: ReturnType<typeof relayHost> | undefined;
    const injected = Buffer.concat([Buffer.from([0, 32]), randomBytes(32)]);
    const { supervisor, exits, state } = start(
      {},
      {
        host: (host) =>
          (relay = relayHost(host, (lane, direction, chunk, before) => {
            const at = replyAndAccept - before;
            if (lane !== 1 || direction !== "toDaemon" || at < 0 || at > chunk.length) return chunk;
            return Buffer.concat([chunk.subarray(0, at), injected, chunk.subarray(at)]);
          })).host,
      },
    );
    cleanups.push(() => relay?.close());
    supervisor.need();
    await until(() => exits.length > 0);
    expect(exits[0]).toMatchObject({ failure: true });
    expect(state.egress).toBe(0);
  },
);

it("refuses the real secret on a lane tag already taken, and on any lane once both are up", async () => {
  // The supervisor's egress lane waits until the duplicate has been tried, so the secret is still
  // live in the child while only the priority tag is taken.
  const secret = new Uint8Array(randomBytes(32));
  let releaseEgress: (() => void) | undefined;
  const egressGate = new Promise<void>((resolve) => (releaseEgress = resolve));
  let priorityAccepted = false;
  let connects = 0;
  const { supervisor, control } = start(
    {},
    {
      randomBytes: () => secret.slice(),
      host: (host) => ({
        spawn: (binary) => host.spawn(binary),
        async connect(path) {
          const first = connects++ === 0;
          if (!first) await egressGate;
          const socket = await host.connect(path);
          if (!first) return socket;
          return {
            ...socket,
            onData(listener) {
              socket.onData((chunk) => {
                priorityAccepted = true;
                listener(chunk);
              });
            },
          };
        },
      }),
    },
  );
  supervisor.need();
  await until(() => priorityAccepted);

  const refused = async (lane: "priority" | "egress") => {
    const intruder = await connectLane(control());
    await expect(authenticateLane(intruder, lane, secret.slice(), nonce)).rejects.toThrow();
    intruder.destroy();
  };
  await refused("priority");
  releaseEgress?.();
  await until(() => supervisor.health() === "healthy");
  // A replay of the secret that opened both lanes is refused on either tag.
  await refused("priority");
  await refused("egress");
  expect(supervisor.health()).toBe("healthy");
});

it("answers revocations well inside the deadline while the normal lane is saturated", async () => {
  // The stand-in also keeps the egress lane full; the real binary's egress stays idle here, as no
  // source turns it on.
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
