import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { authenticateLane, connectLane } from "./lanes.ts";
import {
  legacyMediaSettings,
  MediaSupervisor,
  nodeMediaHost,
  systemMediaClock,
  type MediaExit,
} from "./supervisor.ts";

// A real child and a real control socket: spawning, stdio framing under real pipe
// backpressure, socket lane authentication and the priority lane can't be covered by the
// in-memory fakes of supervisor.test.ts.
const fake = fileURLToPath(new URL("./__fixtures__/fake-ace-media.ts", import.meta.url));
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

function start(env: NodeJS.ProcessEnv = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ace-media-"));
  const exits: MediaExit[] = [];
  const state = { replays: 0, egress: 0 };
  const supervisor = new MediaSupervisor({
    version: "0.0.0-test",
    binary: fake,
    runtimeDir,
    dataDir: runtimeDir,
    settings: () => ({ ...legacyMediaSettings, stills: "auto" }),
    host: nodeMediaHost({ ...process.env, ...env }, (script) => ({
      command: process.execPath,
      args: [script],
    })),
    clock: systemMediaClock,
    random: Math.random,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    replay: () => void state.replays++,
    onMessage: () => {},
    onEgress: () => void state.egress++,
    onExit: (exit) => void exits.push(exit),
    log: () => {},
  });
  cleanups.push(() => {
    supervisor.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  const control = () =>
    process.platform === "win32"
      ? `\\\\.\\pipe\\ace-media-fake-${supervisor.snapshot().pid}`
      : join(runtimeDir, "control.sock");
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

it("answers revocations well inside the deadline while the normal lane is saturated and egress is full", async () => {
  const { supervisor, state } = start({ FAKE_MEDIA_EGRESS_FLOOD: "1" });
  supervisor.need();
  await until(() => supervisor.health() === "healthy" && state.egress >= 64);
  const picture = { type: "source.picture", source: "s1", ageMs: 0, epoch: 0 } as const;
  const latencies: number[] = [];
  for (let i = 0; i < 20; i++) {
    // Keep 8 MiB of pictures ahead of every revocation on the normal lane.
    for (let j = 0; j < 8; j++) supervisor.send(picture, new Uint8Array(1024 * 1024));
    const started = performance.now();
    expect(await supervisor.revoke({ type: "revoke", id: `r${i}`, issued: i, device: "d1" })).toBe(
      "answered",
    );
    latencies.push(performance.now() - started);
  }
  const worst = Math.max(...latencies);
  expect(worst, `worst revocation ${worst.toFixed(1)} ms`).toBeLessThan(250);
  expect(state.egress).toBeGreaterThan(64);
  expect(supervisor.health()).toBe("healthy");
});
