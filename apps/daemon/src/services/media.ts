import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BrowserMedia } from "@ace/browser";
import { MediaAccelerationStore } from "@ace/media/acceleration";
import type { IngestProducer, IngestSource } from "@ace/media/ingest-sources";
import type { MediaConnectGrant, MediaOwner } from "@ace/media/media-connections";
import type { MediaDeliveryPort } from "@ace/media/media-viewers";
import { platformRouteCapabilities } from "@ace/media/routes";
import { MediaRuntime } from "@ace/media/runtime";
import {
  legacyMediaSettings,
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
 * The daemon's ace-media for live video (E4, ADR 0147): one `MediaRuntime`, made once the
 * binary is found. It is the only deliverer of live views (X3), so it is made at start; while
 * ace-media isn't healthy, captures take the browser's own path and live views say why.
 */

const MediaSetting = (value: unknown): "auto" | "legacy" => (value === "auto" ? "auto" : "legacy");
/** `media.delivery` is only ever `auto` (X3), so only `media.encode` is read. */
const mediaKeys = ["media.encode"] as const;

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
  /** Relay media streams (D2): dials, hand-overs and relay hellos' tickets. */
  relay: MediaRelayPort;
};

/** The daemon's ace-media as its producers see it. */
export type DaemonMedia = BrowserMedia & {
  delivery(): DaemonDelivery | undefined;
  /**
   * For a long-lived producer (a screen session): its source, kept until closed. Before the
   * runtime exists (`media.encode` never asked for it) the producer waits, and is added once it
   * does, so a session started under `legacy` still moves when the setting turns `auto`.
   */
  attach(producer: IngestProducer): IngestSource;
  /** What ace-media runs on, kept across its restarts and before the runtime exists (empty). */
  acceleration: MediaAccelerationStore;
  /** ace-media's process while it runs. */
  pid(): number | undefined;
};

/** One per daemon: the browser and the screen share it. */
const started = new WeakMap<object, DaemonMedia | undefined>();

export function startMedia(context: ServiceContext): DaemonMedia | undefined {
  if (started.has(context.services)) return started.get(context.services);
  const media = createMedia(context);
  started.set(context.services, media);
  if (media) context.services.mediaDelivery = () => media.delivery();
  if (media) context.services.mediaAcceleration = media.acceleration;
  if (media) context.services.mediaPid = () => media.pid();
  return media;
}

function createMedia(context: ServiceContext): DaemonMedia | undefined {
  if (process.platform === "win32") return undefined; // No lanes in the binary there yet.
  const binary = findMediaBinary();
  if (!binary) return undefined;
  const { services, id, config, resources } = context;
  let settings: MediaSettings = legacyMediaSettings;
  let runtime: MediaRuntime | undefined;
  let starting: Promise<void> | undefined;
  let closed = false;
  let runtimeDir: string | undefined;
  /** Long-lived producers waiting for the runtime, with the source they get then. */
  const waiting = new Map<
    IngestProducer,
    { source: IngestSource | undefined; codecs?: string[] | undefined }
  >();
  /** The runtime's relay port (D2): one for the runtime's life. */
  let relayPort: RuntimeRelayPort | undefined;
  const acceleration = new MediaAccelerationStore();

  const start = () =>
    (starting ??= (async () => {
      const { stdout } = await promisify(execFile)(binary, ["--version"], { timeout: 5_000 });
      if (closed) return;
      runtimeDir = mkdtempSync(join(tmpdir(), "acem-"));
      runtime = new MediaRuntime({
        version: stdout.trim(),
        binary,
        runtimeDir,
        dataDir: config.dataDir,
        settings: () => settings,
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
      }
      runtime.settingsChanged();
    })().catch((error: unknown) => {
      starting = undefined;
      context.log.log("warn", `ace-media is not available: ${String(error)}`);
    }));

  const read = async () => {
    const encode = MediaSetting((await services.settings?.get("media.encode"))?.value);
    settings = { ...legacyMediaSettings, encode };
    // ace-media delivers every live view, so its runtime exists whatever the settings.
    await start();
    runtime?.settingsChanged();
  };
  void read().catch(() => {});
  const stop = services.settings?.onChange((layer, keys) => {
    if (layer.kind === "global" && mediaKeys.some((key) => keys.includes(key)))
      void read().catch(() => {});
  });
  resources.own(() => {
    closed = true;
    stop?.();
    runtime?.dispose();
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  });

  return {
    delivery: () =>
      runtime && relayPort ? daemonDelivery(runtime, relayPort) : undefined,
    acceleration,
    pid: () => runtime?.supervisor.snapshot().pid,
    add: (producer) => runtime?.sources.add(producer),
    routed: (kind) => runtime?.sources.routed(kind) ?? false,
    wanted: (kind) => runtime?.sources.wanted(kind) ?? false,
    pictureCodecs: () => runtime?.pictureCodecs() ?? [],
    endpoint: () => runtime?.sources.endpoint(),
    attach: (producer) => {
      if (runtime) return runtime.sources.add(producer);
      const slot: { source: IngestSource | undefined; codecs?: string[] | undefined } = {
        source: undefined,
      };
      waiting.set(producer, slot);
      return {
        streaming: () => slot.source?.streaming() ?? false,
        reconnect: () => slot.source?.reconnect(),
        codecs: (codecs) => {
          slot.codecs = [...codecs];
          slot.source?.codecs(codecs);
        },
        encodes: (encodes) => slot.source?.encodes(encodes),
        key: (encode) => slot.source?.key(encode),
        picture: (base64, ageMs) => slot.source?.picture(base64, ageMs) ?? false,
        close: () => {
          waiting.delete(producer);
          slot.source?.close();
        },
      };
    },
  };
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
