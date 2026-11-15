import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BrowserMedia } from "@ace/browser";
import { MediaAccelerationStore } from "@ace/media/acceleration";
import type { IngestProducer, IngestSource } from "@ace/media/ingest-sources";
import { platformRouteCapabilities } from "@ace/media/routes";
import { MediaRuntime } from "@ace/media/runtime";
import {
  legacyMediaSettings,
  mediaBinaryPath,
  nodeMediaHost,
  systemMediaClock,
  type MediaSettings,
} from "@ace/media/supervisor";
import type { ServiceContext } from "./types.ts";

/*
 * The daemon's ace-media for live video (E4, ADR 0147): one `MediaRuntime`, made once the
 * binary is found and `media.encode` asks for it. Until then, and whenever ace-media isn't
 * healthy, every capture takes the browser's own path.
 */

const MediaEncode = (value: unknown): "auto" | "legacy" => (value === "auto" ? "auto" : "legacy");

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

/** The daemon's ace-media as its producers see it. */
export type DaemonMedia = BrowserMedia & {
  /**
   * For a long-lived producer (a screen session): its source, kept until closed. Before the
   * runtime exists (`media.encode` never asked for it) the producer waits, and is added once it
   * does, so a session started under `legacy` still moves when the setting turns `auto`.
   */
  attach(producer: IngestProducer): IngestSource;
  /** What ace-media runs on, kept across its restarts and before the runtime exists (empty). */
  acceleration: MediaAccelerationStore;
};

/** One per daemon: the browser and the screen share it. */
const started = new WeakMap<object, DaemonMedia | undefined>();

export function startMedia(context: ServiceContext): DaemonMedia | undefined {
  if (started.has(context.services)) return started.get(context.services);
  const media = createMedia(context);
  started.set(context.services, media);
  if (media) context.services.mediaAcceleration = media.acceleration;
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
  const waiting = new Map<IngestProducer, { source: IngestSource | undefined }>();
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
        // Backoff jitter only.
        random: Math.random,
        listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
        id,
        capabilities: platformRouteCapabilities(process.platform),
        platform: process.platform,
        acceleration,
        log: (level, message, fields) => context.log.log(level, `ace-media: ${message}`, fields),
      });
      for (const [producer, slot] of waiting) slot.source = runtime.sources.add(producer);
      runtime.settingsChanged();
    })().catch((error: unknown) => {
      starting = undefined;
      context.log.log("warn", `ace-media is not available: ${String(error)}`);
    }));

  const read = async () => {
    const value = (await services.settings?.get("media.encode"))?.value;
    settings = { ...legacyMediaSettings, encode: MediaEncode(value) };
    if (settings.encode === "auto") await start();
    runtime?.settingsChanged();
  };
  void read().catch(() => {});
  const stop = services.settings?.onChange((layer, keys) => {
    if (layer.kind === "global" && keys.includes("media.encode")) void read().catch(() => {});
  });
  resources.own(() => {
    closed = true;
    stop?.();
    runtime?.dispose();
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  });

  return {
    acceleration,
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
