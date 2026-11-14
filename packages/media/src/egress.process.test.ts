import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EgressRouter, type EgressUnit, type LegacyConsumers } from "./egress.ts";
import { encodeMediaFrame } from "./frame.ts";
import { RouteWatch } from "./route-watch.ts";
import type { MediaRoutes, RouteCapabilities } from "./routes.ts";
import {
  MediaSupervisor,
  nodeMediaHost,
  systemMediaClock,
  type MediaSettings,
} from "./supervisor.ts";

// One route end to end on the real binary: `encode` on auto with every consumer legacy, so a
// producer streams into ace-media and the egress lane carries its units back to the daemon's
// legacy deliverer, recorder and still maker. What a unit test can't cover is the real egress
// lane between two processes, interleaving two sources on one connection, and the route moving
// back to the daemon when the process dies. Runs when ACE_MEDIA_TEST_BINARY names a built
// ace-media (`bun run check:media` does).
const real = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;

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

function mediaUnit(kind: number, payload: Uint8Array): Uint8Array {
  return encodeMediaFrame({
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
    // Both producers use the same encode id.
    encode: 0,
    epoch: 1,
    codecString: "",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
    payload,
  });
}

/** A producer: the hello with its token, then a keyframe marked `mark` every 20 ms. */
function produce(socketPath: string, token: Uint8Array, mark: number): void {
  const socket = createConnection(socketPath);
  socket.on("error", () => {});
  socket.write(mediaUnit(5, token));
  const timer = setInterval(() => socket.write(mediaUnit(1, new Uint8Array(256).fill(mark))), 20);
  socket.once("close", () => clearInterval(timer));
  cleanups.push(() => {
    clearInterval(timer);
    socket.destroy();
  });
}

function legacy() {
  const got: Record<"deliver" | "record" | "still", EgressUnit[]> = {
    deliver: [],
    record: [],
    still: [],
  };
  const sinks: LegacyConsumers = {
    deliver: (unit) => void got.deliver.push(unit),
    record: (unit) => void got.record.push(unit),
    still: (unit) => void got.still.push(unit),
  };
  return { got, sinks };
}

it.runIf(real)(
  "units from two sources with the same encode id come back on egress to only their own legacy consumers, and the route returns to the daemon when ace-media dies",
  async () => {
    const binary = real ?? "";
    const runtimeDir = mkdtempSync(join(tmpdir(), "ace-media-egress-"));
    const settings: MediaSettings = {
      encode: "auto",
      delivery: "legacy",
      recordings: "legacy",
      stills: "legacy",
    };
    const capabilities: RouteCapabilities = {
      ingest: ["tab"],
      recordings: false,
      stills: false,
      delivery: false,
    };
    const router = new EgressRouter();
    const sources = { a: legacy(), b: legacy() };
    const handles = new Map<string, number>();
    const tokens = new Map<string, Uint8Array>();
    const changes: { at: number; routes: MediaRoutes }[] = [];

    const supervisor: MediaSupervisor = new MediaSupervisor({
      version: execFileSync(binary, ["--version"]).toString().trim(),
      binary,
      runtimeDir,
      dataDir: runtimeDir,
      settings: () => settings,
      host: nodeMediaHost(process.env, (path) => ({ command: path, args: [] })),
      clock: systemMediaClock,
      random: Math.random,
      listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
      replay: () => {
        watch.update();
        const route = watch.routes().tab;
        for (const [id, { sinks }] of Object.entries(sources)) {
          const handle = router.open(id, sinks, route);
          const token = new Uint8Array(randomBytes(32));
          handles.set(id, handle);
          tokens.set(id, token);
          const origin = { kind: "tab" } as const;
          supervisor.send(
            { type: "source.open", source: id, handle, epoch: 1, origin },
            token.slice(),
          );
          if (route.egress) supervisor.send({ type: "source.egress", source: id, on: true });
        }
      },
      onMessage: () => {},
      onEgress: (frame) => router.push(frame),
      onExit: () => {
        for (const handle of handles.values()) router.close(handle);
        watch.update();
      },
      log: () => {},
    });
    const watch: RouteWatch = new RouteWatch({
      settings: () => settings,
      health: () => supervisor.health(),
      capabilities: () => capabilities,
      onChange: (routes) => void changes.push({ at: performance.now(), routes }),
    });
    cleanups.push(() => {
      supervisor.dispose();
      rmSync(runtimeDir, { recursive: true, force: true });
    });

    // Before ace-media is up the producer streams to the daemon.
    expect(watch.routes().tab).toMatchObject({ producer: "daemon", egress: false });
    supervisor.need();
    await until(() => supervisor.health() === "healthy" && handles.size === 2);
    expect(watch.routes().tab).toMatchObject({
      producer: "ace-media",
      egress: true,
      deliverer: "legacy",
      recorder: "legacy",
      stills: "legacy",
    });

    const ingest = supervisor.ingest()?.socket ?? "";
    produce(ingest, tokens.get("a") ?? new Uint8Array(0), 0xa);
    produce(ingest, tokens.get("b") ?? new Uint8Array(0), 0xb);
    await until(() => sources.a.got.still.length >= 5 && sources.b.got.still.length >= 5);
    for (const [id, mark] of [
      ["a", 0xa],
      ["b", 0xb],
    ] as const)
      for (const kind of ["deliver", "record", "still"] as const) {
        const units = sources[id].got[kind];
        expect(units.length).toBeGreaterThanOrEqual(5);
        expect(units.every((unit) => unit.source === id && unit.frame.payload[0] === mark)).toBe(
          true,
        );
      }

    // The daemon closes "a" before ace-media hears of it: its frames still in flight are dropped.
    router.close(handles.get("a") ?? 0);
    const before = sources.a.got.deliver.length;
    await until(() => router.drops().closed > 0);
    expect(sources.a.got.deliver.length).toBe(before);
    supervisor.send({ type: "source.close", source: "a" });
    expect(router.drops().unknown).toBe(0);

    // ace-media dies: the route goes back to the daemon within 2 s.
    const pid = supervisor.snapshot().pid ?? 0;
    const killed = performance.now();
    process.kill(pid, "SIGKILL");
    await until(() => changes.some((c) => c.at > killed && c.routes.tab.producer === "daemon"));
    const back = changes.find((c) => c.at > killed && c.routes.tab.producer === "daemon");
    expect((back?.at ?? Infinity) - killed).toBeLessThan(2_000);
    expect(back?.routes.tab).toMatchObject({ egress: false, tee: false, deliverer: "legacy" });
  },
);
