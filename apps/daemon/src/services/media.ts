import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BrowserMedia } from "@ace/browser";
import { MediaAccelerationStore } from "@ace/media/acceleration";
import type { IngestPage, IngestProducer, IngestSource } from "@ace/media/ingest-sources";
import type { MediaConnectGrant, MediaOwner } from "@ace/media/media-connections";
import type { MediaDeliveryPort } from "@ace/media/media-viewers";
import { platformRouteCapabilities } from "@ace/media/routes";
import { MediaRuntime } from "@ace/media/runtime";
import { refusingRecorder, type MediaRecorder } from "@ace/media/tee-recordings";
import {
  defaultMediaSettings,
  mediaBinaryPath,
  nodeMediaHost,
  systemMediaClock,
  systemWallClock,
  type MediaSettings,
} from "@ace/media/supervisor";
import type { ServiceContext } from "./types.ts";
import type { MediaRelayPort } from "../media-relay/port.ts";
import { RuntimeRelayPort } from "../media-relay/runtime-port.ts";

/*
 * The daemon's ace-media (ADR 0147): one `MediaRuntime`, made once the binary is found. It is
 * the only encoder (X2), the only deliverer of live views (X3) and the only recorder (X1), so it
 * is made at start; while ace-media isn't healthy, live views say they are retrying and why, and
 * a recording refuses to start, saying why.
 */

/**
 * What ace-media is started with: everything through it. No setting is read (ADR 0147: ace-media
 * is the only media path); the wire still carries the values for older binaries.
 */
const mediaSettings: MediaSettings = { ...defaultMediaSettings, encode: "auto" };

/** What makes an executable the one it is: path, size, mtime and inode; undefined if it's gone. */
function executable(path: string): string | undefined {
  try {
    const info = statSync(path);
    return `${path}:${info.size}:${info.mtimeMs}:${info.ino}`;
  } catch {
    return undefined;
  }
}

/** Why ace-media didn't start, for the person. */
function mediaFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Live video can't start: ace's media process didn't run (${detail.slice(0, 160)}).`;
}

/**
 * Delivery while ace-media didn't start: every view is told why, a media connection is refused
 * with the same reason, and asking for one tries to start ace-media again.
 */
export function failedDelivery(reason: string, retry: () => void): DaemonDelivery {
  return {
    serves: () => false,
    unserved: () => reason,
    sourceKinds: () => [],
    sourceState: () => "failed",
    bind: () => undefined,
    granted: () => false,
    why: () => undefined,
    poster: () => Promise.resolve(undefined),
    configure: () => {},
    pause: () => {},
    regrant: () => {},
    unbind: () => {},
    connect: () => {
      retry();
      return Promise.resolve({ ok: false, code: "unavailable", message: reason });
    },
    sessionStarted: () => {},
    sessionEnded: () => {},
    sample: () => {},
  };
}

/** The binary this daemon runs: the bundled one in a release, the Cargo build from source. */
export function findMediaBinary(): string | undefined {
  const entry = process.argv[1];
  if (entry && basename(entry) === "ace.mjs")
    return mediaBinaryPath({
      mode: "release",
      entry,
      platform: process.platform,
      exists: existsSync,
    });
  return mediaBinaryPath({
    mode: "development",
    env: process.env,
    sourceRoot: fileURLToPath(new URL("../../../../", import.meta.url)),
    platform: process.platform,
    exists: existsSync,
  });
}

/**
 * Delivery by ace-media (D1): clients' media connections and the views on them. Present while
 * the runtime exists, so sessions are always cleaned up. Every call answers at once, so a
 * subscribe never waits on ace-media longer than its poster's deadline.
 */
export type DaemonDelivery = MediaDeliveryPort & {
  connect(owner: MediaOwner): Promise<MediaConnectGrant>;
  sessionStarted(session: string): void;
  sessionEnded(session: string): void;
  /** One round trip measured on a main session, with the bytes queued to it. */
  sample(session: string, rttMs: number, backlogBytes: number): void;
  /** Relay media streams (D2): dials, hand-overs and relay hellos' tickets; none while ace-media
   * didn't start. */
  relay?: MediaRelayPort;
};

/** The daemon's ace-media as its producers see it. */
export type DaemonMedia = BrowserMedia & {
  delivery(): DaemonDelivery | undefined;
  /**
   * For a long-lived producer (a screen session): its source, kept until closed. Before the
   * runtime exists (it is made once the binary's version is read) the producer waits, and is
   * added once it does.
   */
  attach(producer: IngestProducer): IngestSource;
  /** What ace-media runs on, kept across its restarts and before the runtime exists (empty). */
  acceleration: MediaAccelerationStore;
  /** ace-media's process while it runs. */
  pid(): number | undefined;
  /** Every recording goes through ace-media (X1). */
  recorder: MediaRecorder;
};

/** A long-lived producer waiting for the runtime, and what it told its source meanwhile. */
type Waiting = {
  source: IngestSource | undefined;
  codecs?: string[] | undefined;
  encodes?: Parameters<IngestSource["encodes"]>[0] | undefined;
  page?: IngestPage | undefined;
};

/** The recorder producers use on a daemon that has no ace-media at all. */
export const noMediaRecorder: MediaRecorder = refusingRecorder(
  "it isn't installed for this computer",
);

/** One per daemon: the browser and the screen share it. */
const started = new WeakMap<object, DaemonMedia | undefined>();

/** What starting ace-media needs of the daemon: no setting among it. */
export type MediaContext = Pick<ServiceContext, "services" | "id" | "resources" | "log"> & {
  config: Pick<ServiceContext["config"], "dataDir">;
};

export function startMedia(context: MediaContext): DaemonMedia | undefined {
  if (started.has(context.services)) return started.get(context.services);
  const media = createMedia(context);
  started.set(context.services, media);
  if (media) context.services.mediaDelivery = () => media.delivery();
  if (media) context.services.mediaAcceleration = media.acceleration;
  if (media) context.services.mediaPid = () => media.pid();
  return media;
}

function createMedia(context: MediaContext): DaemonMedia | undefined {
  if (process.platform === "win32") return undefined; // No lanes in the binary there yet.
  const binary = findMediaBinary();
  if (!binary) return undefined;
  const { id, config, resources } = context;
  let runtime: MediaRuntime | undefined;
  /** Why ace-media didn't start, until a later try does: what live views and recordings say. */
  let failure: string | undefined;
  /** Failed starts in a row, and when the next try may run: 1 s doubling to 60 s. */
  let failures = 0;
  let retryAt = 0;
  /** The executable that failed (path, size, mtime, inode): a replaced one is tried at once. */
  let failedAs: string | undefined;
  let starting: Promise<void> | undefined;
  let closed = false;
  let runtimeDir: string | undefined;
  /** Long-lived producers waiting for the runtime, with the source they get then. */
  const waiting = new Map<IngestProducer, Waiting>();
  /** The runtime's relay port (D2): one for the runtime's life. */
  let relayPort: RuntimeRelayPort | undefined;
  const acceleration = new MediaAccelerationStore();

  const start = () => {
    // Within the cooldown after a failed start, every ask gets the cached reason: no new try.
    // A replaced executable (an update) ends the cooldown: it is a different program.
    if (
      !starting &&
      failure !== undefined &&
      performance.now() < retryAt &&
      executable(binary) === failedAs
    )
      return Promise.resolve();
    if (starting) return starting;
    // Fingerprinted before its probe runs: an update landing mid-probe is a different program,
    // so the failure that comes is cached against the one that ran, never the replacement.
    const trying = executable(binary);
    return (starting = (async () => {
      const { stdout } = await promisify(execFile)(binary, ["--version"], { timeout: 5_000 });
      if (closed) return;
      runtimeDir = mkdtempSync(join(tmpdir(), "acem-"));
      runtime = new MediaRuntime({
        version: stdout.trim(),
        binary,
        runtimeDir,
        dataDir: config.dataDir,
        settings: () => mediaSettings,
        host: nodeMediaHost(process.env),
        clock: systemMediaClock,
        wallClock: systemWallClock,
        // Backoff jitter only.
        random: Math.random,
        listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
        id,
        capabilities: platformRouteCapabilities(process.platform),
        platform: process.platform,
        acceleration,
        log: (level, message, fields) => context.log.log(level, `ace-media: ${message}`, fields),
        onMessage: (message, payload) => relayPort?.message(message, payload),
        onExit: () => relayPort?.exit(),
      });
      relayPort = new RuntimeRelayPort(runtime);
      for (const [producer, slot] of waiting) {
        slot.source = runtime.sources.add(producer);
        if (slot.codecs) slot.source.codecs(slot.codecs);
        if (slot.page) slot.source.page?.(slot.page);
        if (slot.encodes) slot.source.encodes(slot.encodes);
      }
      failure = undefined;
      failures = 0;
      runtime.settingsChanged();
    })().catch((error: unknown) => {
      starting = undefined;
      failure = mediaFailure(error);
      retryAt = performance.now() + Math.min(1_000 * 2 ** failures, 60_000);
      failedAs = trying;
      failures++;
      context.log.log("warn", `ace-media is not available: ${String(error)}`);
      // Producers waiting for the runtime get none from this try: their views say why.
      for (const producer of waiting.keys()) producer.stopped?.(failure, "unavailable");
    }));
  };

  // ace-media is the only media path: it starts with the daemon, reading no setting.
  void start();
  resources.own(() => {
    closed = true;
    runtime?.dispose();
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  });

  return {
    recorder: {
      start: async (spec) => {
        await start();
        if (!runtime)
          return refusingRecorder(closed ? "the daemon is stopping" : "it didn't start").start(
            spec,
          );
        return runtime.recordings.start(spec);
      },
    },
    delivery: () =>
      runtime && relayPort
        ? daemonDelivery(runtime, relayPort)
        : failure
          ? failedDelivery(failure, () => void start())
          : undefined,
    acceleration,
    pid: () => runtime?.supervisor.snapshot().pid,
    // A producer that comes while the runtime is still being made waits for it, as a screen does.
    // After a failed start a tab has no source; asking tries again (within the cooldown, not).
    add: (producer) => {
      if (runtime || failure === undefined) return attach(producer);
      void start();
      return undefined;
    },
    routed: (kind) => runtime?.sources.routed(kind) ?? false,
    wanted: (kind) => runtime?.sources.wanted(kind) ?? false,
    pictureCodecs: () => runtime?.pictureCodecs() ?? [],
    endpoint: () => runtime?.sources.endpoint(),
    attach: (producer) => attach(producer),
  };

  function attach(producer: IngestProducer): IngestSource {
    if (runtime) return runtime.sources.add(producer);
    const slot: Waiting = { source: undefined };
    waiting.set(producer, slot);
    if (failure !== undefined) producer.stopped?.(failure, "unavailable");
    return {
      streaming: () => slot.source?.streaming() ?? false,
      reconnect: () => slot.source?.reconnect(),
      codecs: (codecs) => {
        slot.codecs = [...codecs];
        slot.source?.codecs(codecs);
      },
      page: (page) => {
        slot.page = { ...page };
        slot.source?.page?.(page);
      },
      // Kept for the source the runtime will open: a JPEG source's encodes are asked once.
      encodes: (encodes) => {
        slot.encodes = encodes;
        slot.source?.encodes(encodes);
      },
      key: (encode) => slot.source?.key(encode),
      epoch: (epoch, followsPrivate) => slot.source?.epoch?.(epoch, followsPrivate),
      close: () => {
        waiting.delete(producer);
        slot.source?.close();
      },
    };
  }
}

/**
 * Delivery by a live runtime, as producers and sessions see it. Built on every lookup; `relay`
 * is the runtime's one port, so lookups never add watchers.
 */
export function daemonDelivery(live: MediaRuntime, relay: MediaRelayPort): DaemonDelivery {
  return {
    ...live.delivery(),
    connect: (owner) => live.connections.connect(owner),
    sessionStarted: (session) => live.links.started(session),
    sessionEnded: (session) => {
      live.links.ended(session);
      // The revocation rule is already held by the supervisor, so a failed close needs no report.
      void live.connections.sessionClosed(session).catch(() => {});
    },
    sample: (session, rttMs, backlogBytes) => live.links.sample(session, rttMs, backlogBytes),
    relay,
  };
}
