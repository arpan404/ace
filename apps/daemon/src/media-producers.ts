import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MediaProducers } from "@ace/media/producers";
import {
  mediaBinaryPath,
  nodeMediaHost,
  systemMediaClock,
  type MediaSettings,
} from "@ace/media/supervisor";
import type { SettingsService } from "@ace/settings";

/**
 * ace-media's producers in the daemon (ADR 0147, phase 2): Mac screens stream into its ingest
 * while `media.encode` is `auto`, and its egress feeds the daemon's own viewer, recorder and
 * stills. The setting defaults to `legacy`, and nothing starts ace-media until it is `auto`.
 * Returns undefined when this install has no ace-media binary.
 */
export async function startMediaProducers(input: {
  settings: Pick<SettingsService, "get" | "subscribe">;
  dataDir: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The daemon's entry script, for a release's bundled binary. */
  entry: string | undefined;
  /** The repository root when running from source. */
  sourceRoot: string;
  platform: NodeJS.Platform;
  log: (level: "debug" | "info" | "warn" | "error", message: string, fields?: unknown) => void;
}): Promise<{ producers: MediaProducers; stop: () => void } | undefined> {
  const { env, platform } = input;
  // A release runs only the binary it carries; a source checkout its own build.
  const bundled = input.entry
    ? mediaBinaryPath({ mode: "release", entry: input.entry, platform, exists: existsSync })
    : undefined;
  const binary =
    bundled ??
    mediaBinaryPath({
      mode: "development",
      env,
      sourceRoot: input.sourceRoot,
      platform,
      exists: existsSync,
    });
  if (!binary) return undefined;
  // A release's binary is stamped with the release's version (packaging checks it); a
  // development build reports its own.
  const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  const runtimeDir = join(input.dataDir, "media");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  const settings: MediaSettings = {
    encode: "legacy",
    delivery: "legacy",
    recordings: "legacy",
    stills: "legacy",
  };
  const producers = new MediaProducers({
    version,
    binary,
    runtimeDir,
    dataDir: runtimeDir,
    settings: () => settings,
    host: nodeMediaHost(env, (path) => ({ command: path, args: [] })),
    clock: systemMediaClock,
    random: Math.random,
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    log: input.log,
    platform,
  });
  const apply = (value: unknown) => {
    const encode = value === "auto" ? "auto" : "legacy";
    if (settings.encode === encode) return;
    settings.encode = encode;
    producers.settingsChanged();
  };
  let heard = false;
  const unsubscribe = await input.settings.subscribe(
    { keys: ["media.encode"], scope: {} },
    (event) => {
      if (event.type !== "changed") return;
      const entry = event.entries.find((each) => each.key === "media.encode");
      if (!entry) return;
      heard = true;
      apply(entry.value);
    },
  );
  const initial = (await input.settings.get("media.encode")).value;
  if (!heard) apply(initial);
  return {
    producers,
    stop: () => {
      unsubscribe();
      producers.dispose();
    },
  };
}
