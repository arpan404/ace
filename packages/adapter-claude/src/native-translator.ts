// SPDX-License-Identifier: Apache-2.0
/**
 * The native claude translator shell (E1). It provides the adapter's
 * exported translator over a native handle, chosen at the exported name by
 * one check of the switch module. With the switch on and the addon missing,
 * it fails; never falls back.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Fact, Key } from "@ace/core";
import type { Frame, Translator } from "@ace/engine-api";

interface NativeHandle {
  translate(frameJson: string, now: number): string;
  tick(now: number): string;
  nextDeadline(): number | null | undefined;
  takeDiagnostics(): string;
}

interface Addon {
  ClaudeTranslator: new (rootKey: string) => NativeHandle;
}

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";

/** The addon: `ACE_STORE_ADDON`, else the development build in `native/daemon`. */
function addonPath(): string {
  const explicit = process.env.ACE_STORE_ADDON;
  if (explicit) return explicit;
  return fileURLToPath(
    new URL(`../../../native/daemon/target/debug/${library}`, import.meta.url),
  );
}

let loaded: Addon | undefined;
function addon(): Addon {
  if (loaded) return loaded;
  const path = addonPath();
  // Never fall back: a run with the switch on must prove the native path.
  if (!existsSync(path))
    throw new Error(
      `ACE_TRANSLATORS=claude needs the translator addon at ${path}; build it with cargo build in native/daemon`,
    );
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  // Trusted: the addon this tree built, exporting the classes `ace-daemon-node` declares.
  loaded = module.exports as unknown as Addon;
  return loaded;
}

/** The adapter's exported translator over a native handle. */
export function createNativeTranslator(init: { rootKey: Key }): Translator {
  const handle = new (addon().ClaudeTranslator)(init.rootKey);
  return {
    takeDiagnostics() {
      return JSON.parse(handle.takeDiagnostics()) as import("@ace/protocol").RawPayload[];
    },
    nextDeadline() {
      return handle.nextDeadline() ?? undefined;
    },
    translate(frame: Frame, now: number) {
      const wire = JSON.stringify({
        seq: frame.seq,
        dir: frame.dir,
        channel: frame.channel,
        data: frame.data,
        ...(frame.payload ? { payloadBytes: frame.payload.bytes } : {}),
      });
      return JSON.parse(handle.translate(wire, now)) as Fact[];
    },
    tick(now: number) {
      return JSON.parse(handle.tick(now)) as Fact[];
    },
  };
}
