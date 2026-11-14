import { describe, expect, it } from "vitest";
import { decodeEgress, encodeEgress } from "./frame.ts";
import {
  legacyMediaSettings,
  mediaBinaryPath,
  MediaSupervisor,
  restartDelay,
} from "./supervisor.ts";
import { harness } from "./supervisor-test-support.ts";
import type { ToMedia } from "./wire.ts";

type Owner = Extract<ToMedia, { type: "viewer.open" }>["owner"];
const owner = (device: string, generation = 1): Owner => ({
  session: `session-${device}`,
  device,
  admission: { kind: "pairing", generation },
});
const viewerOpen = (viewer: string, who: Owner, issued: number): ToMedia => ({
  type: "viewer.open",
  viewer,
  connection: `connection-${who.device}`,
  owner: who,
  issued,
  source: "source-1",
  codecs: ["h264"],
  viewport: { width: 800, height: 600, dpr: 2, scale: 1 },
  local: true,
  audio: false,
});
function egressUnit(payloadBytes: number): Uint8Array {
  return encodeEgress(1, 0, {
    kind: 1,
    flags: 0,
    ageUs: 0,
    width: 2,
    height: 2,
    displayWidth: 2,
    displayHeight: 2,
    scale: 1000,
    rotation: 0,
    codec: 1,
    encode: 0,
    epoch: 0,
    codecString: "",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
    payload: new Uint8Array(payloadBytes),
  });
}
const picture = (): ToMedia => ({ type: "source.picture", source: "source-1", ageMs: 0, epoch: 0 });

async function running(overrides: Parameters<typeof harness>[0] = {}) {
  const h = harness(overrides);
  const supervisor = new MediaSupervisor(h.options);
  const release = supervisor.need();
  await h.clock.advance(0);
  return { ...h, supervisor, release };
}

describe("MediaSupervisor", () => {
  it("never starts ace-media while every media setting is legacy", async () => {
    const h = harness({ settings: () => legacyMediaSettings });
    const supervisor = new MediaSupervisor(h.options);
    supervisor.need();
    await h.clock.advance(120_000);
    expect(h.host.children).toHaveLength(0);
    expect(supervisor.snapshot().phase).toBe("disabled");
    expect(supervisor.health()).toBe("unavailable");
  });

  it("starts on first need, authenticates both lanes with init's secret, then listens and replays", async () => {
    const h = harness();
    const supervisor = new MediaSupervisor(h.options);
    await h.clock.advance(1_000);
    expect(h.host.children).toHaveLength(0);

    supervisor.need();
    await h.clock.advance(0);
    const child = h.host.last;
    const secret = child.initSecret;
    expect(secret).toHaveLength(32);
    expect(child.lane("priority").hello?.subarray(5)).toEqual(secret);
    expect(child.lane("egress").hello?.subarray(5)).toEqual(secret);
    // The secret travelled only in init's payload, which is wiped once written.
    expect(child.stdin.chunks[1]?.every((byte) => byte === 0)).toBe(true);
    expect(child.stdin.types("normal")).toEqual(["init", "listen"]);
    expect(h.events.replays).toBe(1);
    expect(supervisor.health()).toBe("healthy");
    expect(supervisor.capabilities()?.[0]?.codec).toBe("avc1.640028");
  });

  it("reports the capabilities a late trial adds, and forwards the change", async () => {
    const h = await running();
    const late = {
      step: "jpeg-encode",
      codec: "jpeg",
      backend: "vaapi",
      hardware: true,
      zeroCopy: false,
      state: "ok",
      maxWidth: 16384,
      maxHeight: 16384,
    } as const;
    h.host.last.send({ type: "capabilities.changed", capabilities: [late] });
    await h.clock.advance(0);
    expect(h.supervisor.capabilities()).toEqual([late]);
    expect(h.supervisor.snapshot().capabilities).toEqual([late]);
    expect(h.events.messages.map((message) => message.type)).toContain("capabilities.changed");
  });

  it("delivers whole egress frames however the bytes are split", async () => {
    const h = await running();
    const bytes = encodeEgress(7, 1, {
      kind: 1,
      flags: 1,
      ageUs: 0,
      width: 2,
      height: 2,
      displayWidth: 2,
      displayHeight: 2,
      scale: 1000,
      rotation: 0,
      codec: 1,
      encode: 0,
      epoch: 0,
      codecString: "avc1.42e01e",
      description: new Uint8Array(0),
      extension: new Uint8Array(0),
      payload: Uint8Array.of(1, 2, 3, 4),
    });
    const egress = h.host.last.lane("egress");
    egress.source.emit(bytes.subarray(0, 10));
    egress.source.emit(bytes.subarray(10));
    expect(h.events.egress.map((frame) => decodeEgress(frame).handle)).toEqual([7]);
  });

  it("kills a child that never sends ready within 5 s and restarts it after backoff", async () => {
    const h = harness();
    h.host.behaviour.ready = false;
    const supervisor = new MediaSupervisor(h.options);
    supervisor.need();
    await h.clock.advance(4_999);
    expect(h.host.last.killed).toBe(false);
    await h.clock.advance(1);
    expect(h.host.last.killed).toBe(true);
    expect(h.events.exits[0]).toMatchObject({
      cause: "ready-timeout",
      failure: true,
      restartInMs: 500,
    });
    expect(supervisor.health()).toBe("restarting");
    await h.clock.advance(500);
    expect(h.host.children).toHaveLength(2);
  });

  it("refuses a child of another version and never restarts it", async () => {
    const h = harness();
    h.host.behaviour.version = "9.9.9";
    const supervisor = new MediaSupervisor(h.options);
    supervisor.need();
    await h.clock.advance(0);
    expect(h.host.last.killed).toBe(true);
    await h.clock.advance(3_600_000);
    expect(h.host.children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "unavailable",
      unavailableReason: "version mismatch",
    });
  });

  it("stops restarting after exit code 2 until the daemon restarts", async () => {
    const h = await running();
    h.host.last.exit(2, null);
    await h.clock.advance(3_600_000);
    expect(h.host.children).toHaveLength(1);
    expect(h.supervisor.health()).toBe("unavailable");
  });

  it("never counts pings held behind normal-lane backpressure as missed", async () => {
    const h = await running();
    const stdin = h.host.last.stdin;
    stdin.blocked = true;
    for (let i = 0; i < 5; i++) h.supervisor.send(picture(), new Uint8Array(1024 * 1024));
    await h.clock.advance(30_000);
    expect(h.host.last.killed).toBe(false);
    stdin.unblock();
    await h.clock.advance(60_000);
    expect(h.host.last.killed).toBe(false);
    expect(h.supervisor.health()).toBe("healthy");
  });

  it("kills a child whose normal lane completes no write across six ping intervals", async () => {
    const h = await running();
    h.host.last.stdin.blocked = true;
    h.supervisor.send(picture(), new Uint8Array(1024));
    // The 5 s tick first sees the stuck write; six intervals later, at 35 s, it is hung.
    await h.clock.advance(34_999);
    expect(h.host.last.killed).toBe(false);
    await h.clock.advance(1);
    expect(h.events.exits[0]).toMatchObject({ cause: "normal-lane-stalled", failure: true });
  });

  it("kills a child that misses three pongs", async () => {
    const h = harness();
    h.host.behaviour.answerPings = false;
    const supervisor = new MediaSupervisor(h.options);
    supervisor.need();
    await h.clock.advance(19_999);
    expect(h.host.last.stdin.types("normal").filter((t) => t === "ping")).toHaveLength(3);
    expect(h.host.last.killed).toBe(false);
    await h.clock.advance(1);
    expect(h.events.exits[0]).toMatchObject({ cause: "missed-pongs", failure: true });
  });

  it("stays up while pongs keep coming", async () => {
    const h = await running();
    await h.clock.advance(300_000);
    expect(h.host.children).toHaveLength(1);
    expect(h.supervisor.snapshot().stats?.rssBytes).toBe(1);
  });

  it("backs off from 0.5 s doubling to 30 s, within ±20 % jitter", () => {
    const bases = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    bases.forEach((base, i) => {
      expect(restartDelay(i + 1, 0.5)).toBe(base);
      expect(restartDelay(i + 1, 0)).toBe(base * 0.8);
      expect(restartDelay(i + 1, 1)).toBe(base * 1.2);
    });
  });

  it("resets backoff after 60 s healthy", async () => {
    const h = await running();
    h.host.last.exit(1, null);
    await h.clock.advance(500);
    h.host.last.exit(1, null);
    await h.clock.advance(1_000);
    expect(h.events.exits.map((exit) => exit.restartInMs)).toEqual([500, 1_000]);
    await h.clock.advance(60_000);
    h.host.last.exit(1, null);
    await h.clock.advance(0);
    expect(h.events.exits[2]?.restartInMs).toBe(500);
  });

  it("marks ace-media unavailable for 10 minutes after five failures in 2 minutes", async () => {
    const h = harness();
    h.host.behaviour.exitAtOnce = 1;
    const supervisor = new MediaSupervisor(h.options);
    supervisor.need();
    await h.clock.advance(7_500);
    expect(h.host.children).toHaveLength(5);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "unavailable",
      unavailableReason: "crash loop",
      lastExit: { code: 1 },
    });
    await h.clock.advance(599_000);
    expect(h.host.children).toHaveLength(5);
    h.host.behaviour.exitAtOnce = undefined;
    await h.clock.advance(1_000);
    expect(h.host.children).toHaveLength(6);
    expect(supervisor.health()).toBe("healthy");
  });

  it("shuts down 60 s after the last release, killing past the grace period, without a restart", async () => {
    const h = await running();
    h.release();
    await h.clock.advance(59_999);
    expect(h.host.last.lane("priority").types()).toEqual([]);
    await h.clock.advance(1);
    expect(h.host.last.lane("priority").types()).toEqual(["shutdown"]);
    await h.clock.advance(5_000);
    expect(h.host.last.killed).toBe(true);
    expect(h.events.exits[0]).toMatchObject({ cause: "idle", failure: false });
    await h.clock.advance(600_000);
    expect(h.host.children).toHaveLength(1);
    expect(h.supervisor.snapshot().phase).toBe("idle");
  });

  it("counts an idle shutdown that closes its lanes and exits as no failure", async () => {
    const h = await running();
    h.release();
    await h.clock.advance(60_000);
    h.host.last.lane("priority").source.end();
    h.host.last.exit(0, null);
    await h.clock.advance(0);
    expect(h.events.exits[0]).toMatchObject({ cause: "idle", failure: false });
    expect(h.supervisor.snapshot().recentFailures).toBe(0);
  });

  it("refuses work during an idle shutdown and starts afresh for a need that came meanwhile", async () => {
    const h = await running();
    h.release();
    await h.clock.advance(60_000);
    expect(h.supervisor.snapshot().phase).toBe("stopping");
    h.supervisor.need();
    expect(h.supervisor.send(picture(), new Uint8Array(1))).toBe(false);
    expect(h.supervisor.health()).toBe("restarting");
    h.host.last.exit(0, null);
    await h.clock.advance(0);
    expect(h.host.children).toHaveLength(2);
    expect(h.events.replays).toBe(2);
    expect(h.supervisor.health()).toBe("healthy");
  });

  it("keeps running when a new need arrives before the idle timeout", async () => {
    const h = await running();
    h.release();
    await h.clock.advance(30_000);
    h.supervisor.need();
    await h.clock.advance(120_000);
    expect(h.host.last.killed).toBe(false);
  });

  it("resolves a revocation once ace-media answers on the priority lane", async () => {
    const h = await running();
    const result = await h.supervisor.revoke({ type: "revoke", id: "r1", issued: 3, device: "d1" });
    expect(result).toBe("answered");
    expect(h.host.last.lane("priority").types()).toEqual(["revoke"]);
    await h.clock.advance(1_000);
    expect(h.host.last.killed).toBe(false);
  });

  it("kills a child that leaves a revocation unanswered for 250 ms and restarts it", async () => {
    const h = harness();
    h.host.behaviour.answerRevocations = false;
    const supervisor = new MediaSupervisor(h.options);
    supervisor.need();
    await h.clock.advance(0);
    const result = supervisor.revoke({
      type: "connection.close",
      id: "c1",
      connection: "x",
      reason: "session",
    });
    await h.clock.advance(249);
    expect(h.host.last.killed).toBe(false);
    await h.clock.advance(1);
    expect(h.host.last.killed).toBe(true);
    expect(await result).toBe("killed");
    expect(h.events.exits[0]).toMatchObject({ cause: "revocation-timeout", failure: true });
    await h.clock.advance(500);
    expect(h.host.children).toHaveLength(2);
    expect(h.events.replays).toBe(2);
  });

  it("sends a revocation ahead of a saturated normal lane", async () => {
    const h = await running();
    const stdin = h.host.last.stdin;
    stdin.blocked = true;
    for (let i = 0; i < 20; i++) h.supervisor.send(picture(), new Uint8Array(1024 * 1024));
    // The egress lane is full too: 4 MiB of frames arriving while the revocation goes out.
    const egress = h.host.last.lane("egress");
    const unit = egressUnit(64 * 1024);
    for (let i = 0; i < 64; i++) egress.source.emit(unit);
    const result = await h.supervisor.revoke({ type: "revoke", id: "r1", issued: 1, device: "d1" });
    expect(result).toBe("answered");
    expect(stdin.types("normal").filter((t) => t === "source.picture")).toHaveLength(1);
    expect(h.events.egress).toHaveLength(64);
  });

  it("drops grants queued behind a revocation for their owner and refuses later ones", async () => {
    const h = await running();
    const stdin = h.host.last.stdin;
    stdin.blocked = true;
    h.supervisor.send(picture(), new Uint8Array(1024));
    const keys = new Uint8Array(120).fill(0xaa);
    h.supervisor.send(viewerOpen("v1", owner("d1"), 5));
    h.supervisor.send(
      {
        type: "relay.keys",
        stream: "s1",
        connection: "connection-d1",
        owner: owner("d1"),
        issued: 6,
      },
      keys,
    );
    h.supervisor.send(viewerOpen("v2", owner("d2"), 7));
    h.supervisor.send(viewerOpen("v3", owner("d1", 2), 7));
    await h.supervisor.revoke({
      type: "revoke",
      id: "r1",
      issued: 8,
      device: "d1",
      admission: { kind: "pairing", generation: 1 },
    });
    expect(keys.every((byte) => byte === 0)).toBe(true);
    expect(h.supervisor.send(viewerOpen("v4", owner("d1"), 6))).toBe(false);
    expect(h.supervisor.send(viewerOpen("v5", owner("d1"), 9))).toBe(true);
    stdin.unblock();
    const viewers = stdin
      .messages("normal")
      .flatMap(({ message }) => (message.type === "viewer.open" ? [message.viewer] : []));
    expect(viewers).toEqual(["v2", "v3", "v5"]);
  });

  it("kills and restarts ace-media when the priority lane drops", async () => {
    const h = await running();
    h.host.last.lane("priority").source.end();
    await h.clock.advance(0);
    expect(h.events.exits[0]).toMatchObject({ cause: "lane-closed", failure: true });
    await h.clock.advance(500);
    expect(h.host.children).toHaveLength(2);
    expect(h.supervisor.health()).toBe("healthy");
  });

  it("ends the run when a lane closes after its accept while the other is still authenticating", async () => {
    const h = harness();
    h.host.behaviour.hold = "egress";
    const supervisor = new MediaSupervisor(h.options);
    supervisor.need();
    await h.clock.advance(0);
    h.host.last.lane("priority").source.end();
    await h.clock.advance(0);
    expect(h.host.last.killed).toBe(true);
    h.host.last.releaseHeld();
    await h.clock.advance(0);
    expect(supervisor.health()).toBe("restarting");
    expect(h.events.replays).toBe(0);
    expect(h.events.exits[0]).toMatchObject({ cause: "lane-closed", failure: true });
  });

  it("kills a child that refuses the lane secret", async () => {
    const h = harness();
    h.host.behaviour.refuseLanes = true;
    const supervisor = new MediaSupervisor(h.options);
    supervisor.need();
    await h.clock.advance(0);
    expect(h.host.last.killed).toBe(true);
    expect(h.events.replays).toBe(0);
    expect(h.events.exits[0]).toMatchObject({ cause: "lane-closed", failure: true });
  });

  it("fails in-flight stills, connections and sources when ace-media exits, and wipes their secrets", async () => {
    const h = await running();
    const token = new Uint8Array(32).fill(9);
    h.supervisor.send(
      { type: "source.open", source: "s1", handle: 1, epoch: 0, origin: { kind: "tab" } },
      token,
    );
    h.supervisor.send({
      type: "still.take",
      request: "still-1",
      source: "s1",
      maxWidth: 100,
      maxHeight: 100,
      maxPixels: 10_000,
      quality: 80,
      deadlineMs: 1_000,
    });
    h.supervisor.send(
      { type: "media.ticket", connection: "c1", owner: owner("d1"), issued: 1, expiresAt: 30_000 },
      new Uint8Array(32).fill(1),
    );
    h.supervisor.send({
      type: "record.start",
      recording: "rec-1",
      source: "s1",
      directory: "/r",
      maxBytes: 1,
      pointerTrack: false,
    });
    h.supervisor.send({
      type: "record.start",
      recording: "rec-2",
      source: "s1",
      directory: "/r",
      maxBytes: 1,
      pointerTrack: false,
    });
    // A stopped recording still awaits its record.done; rec-2's arrives, rec-1's never does.
    h.supervisor.send({ type: "record.stop", recording: "rec-1" });
    h.supervisor.send({ type: "record.stop", recording: "rec-2" });
    h.host.last.send({ type: "record.done", recording: "rec-2", parts: [] });
    h.host.last.send(
      { type: "still.done", request: "still-1", width: 1, height: 1 },
      new Uint8Array(4),
    );
    h.supervisor.send({
      type: "still.take",
      request: "still-2",
      source: "s1",
      maxWidth: 100,
      maxHeight: 100,
      maxPixels: 10_000,
      quality: 80,
      deadlineMs: 1_000,
    });
    await h.clock.advance(0);
    expect(token.every((byte) => byte === 0)).toBe(true);
    h.host.last.exit(null, "SIGSEGV");
    await h.clock.advance(0);
    expect(h.events.exits[0]).toMatchObject({
      cause: "crashed",
      failure: true,
      stills: ["still-2"],
      connections: ["c1"],
      sources: ["s1"],
      recordings: ["rec-1"],
    });
    expect(h.supervisor.send(picture(), new Uint8Array(1))).toBe(false);
  });
});

const exists = (paths: string[]) => (path: string) => paths.includes(path);
const fromSource = (paths: string[], env: Record<string, string> = {}) =>
  mediaBinaryPath({
    mode: "development",
    env,
    sourceRoot: "/src",
    platform: "linux",
    exists: exists(paths),
  });

describe("mediaBinaryPath", () => {
  it("runs only the bundled binary in a release, whatever ACE_MEDIA_PATH says", () => {
    const original = process.env.ACE_MEDIA_PATH;
    process.env.ACE_MEDIA_PATH = "/tmp/evil";
    try {
      expect(
        mediaBinaryPath({
          mode: "release",
          entry: "/rel/ace.mjs",
          platform: "linux",
          exists: exists(["/rel/media/ace-media"]),
        }),
      ).toBe("/rel/media/ace-media");
    } finally {
      if (original === undefined) delete process.env.ACE_MEDIA_PATH;
      else process.env.ACE_MEDIA_PATH = original;
    }
  });
  it("finds a release's and the desktop app's media folder, and nothing when it is missing", () => {
    expect(
      mediaBinaryPath({
        mode: "release",
        entry: "/rel/ace.mjs",
        platform: "win32",
        exists: exists(["/rel/media/ace-media.exe"]),
      }),
    ).toBe("/rel/media/ace-media.exe");
    expect(
      mediaBinaryPath({
        mode: "release",
        entry: "/App/Resources/daemon/ace.mjs",
        platform: "darwin",
        exists: (path) =>
          path === "/App/Resources/media/ace-media" ||
          (path.startsWith("/App/Resources/daemon/") && !path.endsWith("ace.mjs")),
      }),
    ).toBe("/App/Resources/media/ace-media");
    expect(
      mediaBinaryPath({
        mode: "release",
        entry: "/rel/ace.mjs",
        platform: "linux",
        exists: exists([]),
      }),
    ).toBeUndefined();
  });
  it("honours ACE_MEDIA_PATH in development, then the source tree's release and debug builds", () => {
    const release = "/src/native/media/target/release/ace-media";
    const debug = "/src/native/media/target/debug/ace-media";
    expect(fromSource([release], { ACE_MEDIA_PATH: "/x/ace-media" })).toBe("/x/ace-media");
    expect(fromSource([release, debug])).toBe(release);
    expect(fromSource([debug])).toBe(debug);
    expect(fromSource([])).toBeUndefined();
  });
});
