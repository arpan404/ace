// SPDX-License-Identifier: Apache-2.0
/**
 * The native Codex translator (E1): the exported translator over a native
 * handle, chosen at the exported name by one check of the switch module.
 * With the switch on and the addon missing, it fails; it never falls back.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Key } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { Frame, Translator } from "@ace/engine-api";

interface NativeHandle {
  translate(frameJson: string, now: number): string;
  tick(now: number): string;
  takeDiagnostics(): string;
  nextDeadline(): number | undefined;
}

interface NativeAddon {
  NativeCodexTranslator: new (threadId: string, rootKey: string) => NativeHandle;
}

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";

function addonPath(): string {
  const explicit = process.env.ACE_STORE_ADDON;
  if (explicit) return explicit;
  return fileURLToPath(
    new URL(`../../../native/daemon/target/release/${library}`, import.meta.url),
  );
}

let loaded: NativeAddon | undefined;
function addon(): NativeAddon {
  if (loaded) return loaded;
  const path = addonPath();
  if (!existsSync(path))
    throw new Error(
      `ACE_TRANSLATORS=codex needs the native addon at ${path}; build it with cargo build --release in native/daemon`,
    );
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  loaded = module.exports as unknown as NativeAddon;
  return loaded;
}

/** A native Codex translator: frames go as JSON, facts come back as JSON. */
export function createNativeCodexTranslator(init: {
  threadId: ThreadId;
  rootKey: Key;
}): Translator {
  const handle = new (addon().NativeCodexTranslator)(
    String(init.threadId),
    init.rootKey,
  );
  return {
    translate(frame: Frame, now: number) {
      const facts = JSON.parse(
        handle.translate(
          JSON.stringify({
            seq: frame.seq,
            t: frame.t,
            dir: frame.dir,
            channel: frame.channel,
            data: frame.data,
          }),
          now,
        ),
      );
      return facts;
    },
    tick(now: number) {
      return JSON.parse(handle.tick(now));
    },
    takeDiagnostics() {
      return JSON.parse(handle.takeDiagnostics());
    },
    nextDeadline() {
      return handle.nextDeadline() ?? undefined;
    },
  };
}
