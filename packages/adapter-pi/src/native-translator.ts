// SPDX-License-Identifier: Apache-2.0
/**
 * The native Pi translator behind `ACE_TRANSLATORS=pi` (E1). It holds a
 * native handle and sends each frame as JSON, parsing the facts back.
 */

import type { Translator, Frame } from "@ace/engine-api";
import type { RawPayload, ThreadId } from "@ace/protocol";
import type { Key } from "@ace/core";
import { translatorBackend } from "@ace/provider-kit/native-switches";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface NativeHandle {
  translate(frameJson: string, now: number): string;
  tick(now: number): string;
  takeDiagnostics(): string;
  nextDeadline(): number | undefined;
}

interface NativeAddon {
  PiTranslatorNative: new (threadId: string, rootKey: string) => NativeHandle;
}

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";

function addonPath(): string {
  const explicit = process.env.ACE_TRANSLATORS_ADDON ?? process.env.ACE_STORE_ADDON;
  if (explicit) return explicit;
  return fileURLToPath(
    new URL(`../../../native/daemon/target/release/${library}`, import.meta.url),
  );
}

let loaded: NativeAddon | undefined;
function addon(): NativeAddon {
  if (loaded) return loaded;
  if (translatorBackend("pi") !== "native") throw new Error("Pi native translator is off");
  const path = addonPath();
  if (!existsSync(path))
    throw new Error(
      `ACE_TRANSLATORS=pi needs the translator addon at ${path}; build it with cargo build --release in native/daemon`,
    );
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  loaded = module.exports as unknown as NativeAddon;
  return loaded;
}

export function createNativePiTranslator(init: { threadId: ThreadId; rootKey: Key }): Translator {
  const handle = new (addon().PiTranslatorNative)(String(init.threadId), init.rootKey);
  return {
    takeDiagnostics(): RawPayload[] {
      return JSON.parse(handle.takeDiagnostics()) as RawPayload[];
    },
    nextDeadline(): number | undefined {
      return handle.nextDeadline() ?? undefined;
    },
    translate(frame: Frame, now: number): ReturnType<Translator["translate"]> {
      const factsJson = handle.translate(
        JSON.stringify({
          seq: frame.seq,
          t: frame.t,
          dir: frame.dir,
          channel: frame.channel,
          data: frame.data,
        }),
        now,
      );
      return JSON.parse(factsJson);
    },
    tick(now: number): ReturnType<Translator["tick"]> {
      return JSON.parse(handle.tick(now));
    },
  };
}
