import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BrowserMedia } from "@ace/browser";
import type { IngestProducer, IngestSource } from "@ace/media/ingest-sources";
import type { MediaConnectGrant, MediaOwner } from "@ace/media/media-connections";
import type { MediaPosterBytes, ViewIntent, ViewViewport } from "@ace/media/media-viewers";
import { platformRouteCapabilities, type SourceKind } from "@ace/media/routes";
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

/*
 * The daemon's ace-media for live video (E4, ADR 0147): one `MediaRuntime`, made once the
 * binary is found and `media.encode` asks for it. Until then, and whenever ace-media isn't
 * healthy, every capture takes the browser's own path.
 */

const MediaSetting = (value: unknown): "auto" | "legacy" => (value === "auto" ? "auto" : "legacy");
const mediaKeys = ["media.encode", "media.delivery"] as const;

/** The binary this daemon runs: the bundled one in a release, the Cargo build from source. */
function findBinary(): string | undefined {
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
 * the runtime exists, so sessions are always cleaned up; it connects and serves only while
 * `media.delivery` is `auto`. Every call answers at once, so a subscribe never waits on
 * ace-media longer than its poster's deadline.
 */
export type DaemonDelivery = {
  /** Whether ace-media delivers this kind's viewers now (setting, health and route). */
  serves(kind: SourceKind): boolean;
  connect(owner: MediaOwner): MediaConnectGrant;
  sessionStarted(session: string): void;
  sessionEnded(session: string): void;
  /** One round trip measured on a main session, with the bytes queued to it. */
  sample(session: string, rttMs: number, backlogBytes: number): void;
  bind(intent: ViewIntent): boolean;
  granted(viewer: string): boolean;
  poster(viewer: string): Promise<MediaPosterBytes | undefined>;
  configure(viewer: string, viewport: ViewViewport, audio: boolean): void;
  pause(viewer: string, paused: boolean): void;
  unbind(viewer: string): void;
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
};

/** One per daemon: the browser and the screen share it. */
const started = new WeakMap<object, DaemonMedia | undefined>();

export function startMedia(context: ServiceContext): DaemonMedia | undefined {
  if (started.has(context.services)) return started.get(context.services);
  const media = createMedia(context);
  started.set(context.services, media);
  if (media) context.services.mediaDelivery = () => media.delivery();
  return media;
}

function createMedia(context: ServiceContext): DaemonMedia | undefined {
  if (process.platform === "win32") return undefined; // No lanes in the binary there yet.
  const binary = findBinary();
  if (!binary) return undefined;
  const { services, id, config, resources } = context;
  let settings: MediaSettings = legacyMediaSettings;
  let runtime: MediaRuntime | undefined;
  let starting: Promise<void> | undefined;
  let closed = false;
  let runtimeDir: string | undefined;
  /** Long-lived producers waiting for the runtime, with the source they get then. */
  const waiting = new Map<IngestProducer, { source: IngestSource | undefined }>();
  /** Relay media streams watching ace-media's messages (D2). */
  const relayHooks = new Set<Parameters<MediaRelayPort["watch"]>[0]>();

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
        log: (level, message, fields) => context.log.log(level, `ace-media: ${message}`, fields),
        onMessage: (message, payload) => {
          for (const hooks of relayHooks) hooks.message(message, payload);
        },
        onExit: () => {
          for (const hooks of relayHooks) hooks.exit();
        },
      });
      for (const [producer, slot] of waiting) slot.source = runtime.sources.add(producer);
      runtime.settingsChanged();
    })().catch((error: unknown) => {
      starting = undefined;
      context.log.log("warn", `ace-media is not available: ${String(error)}`);
    }));

  const read = async () => {
    const [encode, delivery] = await Promise.all(
      mediaKeys.map(async (key) => MediaSetting((await services.settings?.get(key))?.value)),
    );
    settings = {
      ...legacyMediaSettings,
      encode: encode ?? "legacy",
      delivery: delivery ?? "legacy",
    };
    if (settings.encode === "auto" || settings.delivery === "auto") await start();
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

  const delivery = (live: MediaRuntime): DaemonDelivery => ({
    // Frames must be in ace-media for it to deliver them: the producer streams there.
    serves: (kind) => {
      const route = live.routes.routes()[kind];
      return route.deliverer === "ace-media" && route.producer === "ace-media";
    },
    connect: (owner) =>
      settings.delivery === "auto"
        ? live.connections.connect(owner)
        : { ok: false, code: "unavailable", message: "ace-media isn't serving viewers." },
    sessionStarted: (session) => live.links.started(session),
    sessionEnded: (session) => {
      live.links.ended(session);
      void live.connections.sessionClosed(session);
    },
    sample: (session, rttMs, backlogBytes) => live.links.sample(session, rttMs, backlogBytes),
    bind: (intent) => live.viewers.bind(intent),
    granted: (viewer) => live.viewers.granted(viewer),
    poster: (viewer) => live.viewers.poster(viewer),
    configure: (viewer, viewport, audio) => live.viewers.configure(viewer, viewport, audio),
    pause: (viewer, paused) => live.viewers.pause(viewer, paused),
    unbind: (viewer) => live.viewers.unbind(viewer),
    relay: {
      send: (message, payload) => live.supervisor.send(message, payload),
      closeStream: (message) => void live.supervisor.revoke(message),
      need: () => live.supervisor.need(),
      available: () => settings.delivery === "auto" && live.supervisor.health() !== "unavailable",
      claim: (ticket, claimant) => live.connections.claimRelay(ticket, claimant),
      watch: (hooks) => void relayHooks.add(hooks),
    },
  });

  return {
    delivery: () => (runtime ? delivery(runtime) : undefined),
    add: (producer) => runtime?.sources.add(producer),
    routed: (kind) => runtime?.sources.routed(kind) ?? false,
    wanted: (kind) => runtime?.sources.wanted(kind) ?? false,
    pictureCodecs: () => runtime?.pictureCodecs() ?? [],
    endpoint: () => runtime?.sources.endpoint(),
    attach: (producer) => {
      if (runtime) return runtime.sources.add(producer);
      const slot: { source: IngestSource | undefined } = { source: undefined };
      waiting.set(producer, slot);
      return {
        streaming: () => slot.source?.streaming() ?? false,
        reconnect: () => slot.source?.reconnect(),
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
