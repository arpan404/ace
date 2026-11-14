import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BrowserMedia } from "@ace/browser";
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

export function startMedia(context: ServiceContext): BrowserMedia | undefined {
  if (process.platform === "win32") return undefined; // No lanes in the binary there yet.
  const binary = findBinary();
  if (!binary) return undefined;
  const { services, id, config, resources } = context;
  let settings: MediaSettings = legacyMediaSettings;
  let runtime: MediaRuntime | undefined;
  let starting: Promise<void> | undefined;
  let closed = false;
  let runtimeDir: string | undefined;

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
        log: (level, message, fields) => context.log.log(level, `ace-media: ${message}`, fields),
      });
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
    open: (kind, listener, ids) => runtime?.sources.open(kind, { kind }, listener, ids),
    routed: (kind) => runtime?.sources.routed(kind) ?? false,
    wanted: (kind) => runtime?.sources.wanted(kind) ?? false,
    pictureCodecs: () => runtime?.pictureCodecs() ?? [],
  };
}
