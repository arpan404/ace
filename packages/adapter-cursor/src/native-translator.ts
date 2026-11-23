// SPDX-License-Identifier: Apache-2.0
/**
 * The native Cursor translator shell (E1). It implements `Translator` over a
 * native handle: `translate` sends the frame as JSON and parses the facts,
 * `tick` and `takeDiagnostics` likewise. Chosen at the exported translator
 * name by one check of the switch module per instance; with the switch on
 * and the addon missing, construction throws rather than falling back.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Fact } from "@ace/core";
import type { Frame, Translator } from "@ace/engine-api";
import { boundedJson } from "@ace/provider-kit/ipc";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { RawPayload } from "@ace/protocol";
import type { CursorTranslatorOptions } from "./translator.ts";

interface NativeHandle {
  translate(frameJson: string, now: number): string;
  tick(now: number): string;
  takeDiagnostics(): string;
}

interface NativeAddon {
  NativeCursorTranslator: new (
    rootKey: string,
    maxIdentities?: number,
    maxRetainedBytes?: number,
  ) => NativeHandle;
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
    new URL(`../../../native/daemon/target/release/${library}`, import.meta.url),
  );
}

let loaded: NativeAddon | undefined;
function addon(): NativeAddon {
  if (loaded) return loaded;
  const path = addonPath();
  // Never fall back to TypeScript: a run with the switch on must prove the native path.
  if (!existsSync(path))
    throw new Error(
      `ACE_TRANSLATORS=cursor needs the native addon at ${path}; build it with cargo build --release in native/daemon`,
    );
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  // Trusted: the addon this tree built, exporting the classes `ace-daemon-node` declares.
  loaded = module.exports as unknown as NativeAddon;
  return loaded;
}

/** The native Cursor translator: the switch's choice when it names `cursor`. */
export class NativeCursorTranslator implements Translator {
  private handle: NativeHandle;
  constructor(options: CursorTranslatorOptions) {
    this.handle = new (addon().NativeCursorTranslator)(
      options.rootKey,
      options.maxIdentities,
      options.maxRetainedBytes,
    );
  }
  takeDiagnostics(): RawPayload[] {
    return JSON.parse(this.handle.takeDiagnostics()) as RawPayload[];
  }
  tick(now: number): Fact[] {
    return JSON.parse(this.handle.tick(now)) as Fact[];
  }
  translate(frame: Frame, now: number): Fact[] {
    const payload =
      frame.payload !== undefined &&
      ProviderPayload.is(frame.payload) &&
      frame.payload.data === frame.data
        ? frame.payload
        : undefined;
    const frameJson = JSON.stringify({
      seq: frame.seq,
      dir: frame.dir,
      channel: frame.channel,
      data: payload !== undefined ? payload.data : frame.data,
      checked: payload !== undefined,
    });
    return JSON.parse(this.handle.translate(frameJson, now)) as Fact[];
  }
}
