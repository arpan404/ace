import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  legacyMediaSettings,
  MediaSupervisor,
  nodeMediaHost,
  systemMediaClock,
  type MediaExit,
} from "./supervisor.ts";

// A real child and a real control socket: spawning, stdio framing, socket lane authentication
// and the priority lane can't be covered by the in-memory fakes of supervisor.test.ts.
const fake = fileURLToPath(new URL("./__fixtures__/fake-ace-media.ts", import.meta.url));
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("supervises a process that speaks the control protocol: lanes up, revocation answered, killed on dispose", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ace-media-"));
  folders.push(runtimeDir);
  const exits: MediaExit[] = [];
  let replays = 0;
  const supervisor = new MediaSupervisor({
    version: "0.0.0-test",
    binary: fake,
    runtimeDir,
    dataDir: runtimeDir,
    settings: () => ({ ...legacyMediaSettings, stills: "auto" }),
    host: nodeMediaHost(process.env, (script) => ({ command: process.execPath, args: [script] })),
    clock: systemMediaClock,
    random: Math.random,
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    replay: () => void replays++,
    onMessage: () => {},
    onEgress: () => {},
    onExit: (exit) => void exits.push(exit),
    log: () => {},
  });
  supervisor.need();
  await until(() => supervisor.health() === "healthy");
  expect(replays).toBe(1);
  expect(supervisor.snapshot().pid).toBeGreaterThan(0);

  const started = performance.now();
  expect(await supervisor.revoke({ type: "revoke", id: "r1", issued: 1, device: "d1" })).toBe(
    "answered",
  );
  expect(performance.now() - started).toBeLessThan(250);

  supervisor.dispose();
  await until(() => exits.length === 1);
  expect(exits[0]).toMatchObject({ cause: "disposed", failure: false });
});
