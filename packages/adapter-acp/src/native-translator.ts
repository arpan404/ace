// SPDX-License-Identifier: Apache-2.0
/**
 * E1: the native ACP translator shell. It provides the adapter's exported
 * translator over a native handle, chosen at the exported name by one check
 * of the switch module. With the switch off it is unused; with the switch on
 * and the addon missing it fails, never falls back.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Fact } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { Frame, Translator } from "@ace/engine-api";
import { translatorBackend } from "@ace/provider-kit/native-switches";
import type { TranslatorIdentity } from "./identity.ts";
import { antigravityQuirks } from "./quirks/antigravity.ts";
import { genericQuirks } from "./quirks/generic.ts";
import { extensionQuirks } from "./testing/extension-quirks.ts";
import type { AcpQuirks } from "./quirks/types.ts";

interface AddonTranslator {
  translate(frameJson: string, now: number): string;
  tick(now: number): string;
  takeDiagnostics(): string;
  nextDeadline(): number | null | undefined;
}

interface Addon {
  NativeAcpTranslator: new (
    threadId: string,
    rootKey: string,
    generation: string,
    cursor: number,
    quirks: string,
  ) => AddonTranslator;
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
    new URL(
      `../../../native/daemon/target/release/${library}`,
      import.meta.url,
    ),
  );
}

let loaded: Addon | undefined;
function addon(): Addon {
  if (loaded) return loaded;
  const path = addonPath();
  if (!existsSync(path)) {
    throw new Error(
      `ACE_TRANSLATORS=acp needs the native addon at ${path}; build it with cargo build --release in native/daemon`,
    );
  }
  const module = { exports: {} as Record<string, unknown> };
  (process as unknown as { dlopen: (mod: unknown, path: string) => void }).dlopen(
    module,
    path,
  );
  loaded = module.exports as unknown as Addon;
  return loaded;
}

function quirksName(quirks: AcpQuirks): string {
  if (quirks === (antigravityQuirks as AcpQuirks)) return "antigravity";
  if (quirks === (extensionQuirks as AcpQuirks)) return "extension";
  if (quirks === (genericQuirks as AcpQuirks)) return "generic";
  // Fall back by provider for custom quirks objects in tests.
  return quirks.provider === "antigravity" ? "antigravity" : "generic";
}

/** The native translator: frames as JSON in, facts as JSON out, per frame. */
export class NativeAcpTranslator implements Translator {
  private readonly handle: AddonTranslator;
  constructor(
    init: { threadId: ThreadId; rootKey: string; identity: TranslatorIdentity },
    quirks: AcpQuirks = genericQuirks,
  ) {
    const { NativeAcpTranslator } = addon();
    this.handle = new NativeAcpTranslator(
      String(init.threadId),
      init.rootKey,
      init.identity.generation,
      init.identity.cursor,
      quirksName(quirks),
    );
  }
  takeDiagnostics() {
    return JSON.parse(this.handle.takeDiagnostics()) as ReturnType<
      Translator["takeDiagnostics"]
    > extends (infer T)[] | undefined
      ? T[]
      : never;
  }
  nextDeadline() {
    const deadline = this.handle.nextDeadline();
    return (deadline ?? undefined) as number | undefined;
  }
  tick(now: number): Fact[] {
    return JSON.parse(this.handle.tick(now)) as Fact[];
  }
  translate(frame: Frame, now: number): Fact[] {
    // Rust strings are UTF-8 and cannot hold lone surrogates; the TypeScript
    // translator keeps such opaque IDs without throwing. Replace lone
    // surrogates with the replacement character before crossing, so the frame
    // stays valid JSON the native side can parse and the thread still
    // distinguishes the child. Field-for-field JSON holds for all valid
    // UTF-8; lone surrogates normalize to U+FFFD on the native path.
    const frameJson = JSON.stringify({
      seq: frame.seq,
      t: frame.t,
      dir: frame.dir,
      channel: frame.channel,
      data: sanitizeLoneSurrogates(frame.data),
    });
    return JSON.parse(this.handle.translate(frameJson, now)) as Fact[];
  }
}

/**
 * Deep copy replacing lone surrogates with U+FFFD, so the JSON crossing to
 * Rust (UTF-8) stays valid and never throws on provider data.
 */
function sanitizeLoneSurrogates(value: unknown): unknown {
  if (typeof value === "string") return replaceLoneSurrogates(value);
  if (Array.isArray(value)) return value.map(sanitizeLoneSurrogates);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[replaceLoneSurrogates(key)] = sanitizeLoneSurrogates(entry);
    return out;
  }
  return value;
}

function replaceLoneSurrogates(text: string): string {
  return text.replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    "�",
  );
}

/** Whether this process serves the ACP translator natively. */
export function nativeAcpTranslatorEnabled(): boolean {
  return translatorBackend("acp") === "native";
}
