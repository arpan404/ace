// SPDX-License-Identifier: Apache-2.0
/**
 * The native OpenCode translator shell (E1). It implements `Translator` over
 * a native handle: `translate(frame, now)` sends the frame as JSON and
 * parses the facts; `tick`, `takeDiagnostics` and the session's
 * introspection likewise. The exported `OpenCodeTranslator` in
 * `translator.ts` is this class when `ACE_TRANSLATORS` names `opencode`.
 */
import type { Fact, Key } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { RawPayload } from "@ace/protocol";
import type { Frame, Translator } from "@ace/engine-api";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface NativeHandle {
  translateFrame(frameJson: string, nowMs: number): string;
  tick(nowMs: number): string;
  takeDiagnostics(): string;
  isSettled(): boolean;
  liveMessages(session: string): string;
  taskOwner(task: string): string | null;
  liveShell(id: string): boolean;
}

interface Addon {
  OpencodeTranslator: new (rootKey: string) => NativeHandle;
}

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";

/** The addon: `ACE_TRANSLATORS_ADDON`, else the development build. */
function addonPath(): string {
  const explicit = process.env.ACE_TRANSLATORS_ADDON;
  if (explicit) return explicit;
  return fileURLToPath(
    new URL(`../../../native/daemon/target/release/${library}`, import.meta.url),
  );
}

let loaded: Addon | undefined;
function addon(): Addon {
  if (loaded) return loaded;
  const path = addonPath();
  // Never fall back to TypeScript: a run with the switch on must prove the
  // native path.
  if (!existsSync(path))
    throw new Error(
      `ACE_TRANSLATORS=opencode needs the translator addon at ${path}; build it with cargo build --release -p ace-daemon-node in native/daemon`,
    );
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  // Trusted: the addon this tree built, exporting the classes
  // `ace-daemon-node` declares.
  loaded = module.exports as unknown as Addon;
  return loaded;
}

/** The native OpenCode translator, chosen at the exported translator name. */
export class NativeOpenCodeTranslator implements Translator {
  private readonly handle: NativeHandle;
  constructor(init: { threadId: ThreadId; rootKey: Key }) {
    void init.threadId;
    this.handle = new (addon().OpencodeTranslator)(init.rootKey);
  }
  translate(frame: Frame, now: number): Fact[] {
    return JSON.parse(
      this.handle.translateFrame(
        JSON.stringify({
          seq: frame.seq,
          t: frame.t,
          dir: frame.dir,
          channel: frame.channel,
        }),
        JSON.stringify(frame.data ?? null),
        now,
      ),
    ) as Fact[];
  }
  tick(now: number): Fact[] {
    return JSON.parse(this.handle.tick(now)) as Fact[];
  }
  takeDiagnostics(): RawPayload[] {
    return JSON.parse(this.handle.takeDiagnostics()) as RawPayload[];
  }
  /** True while the native translator holds no live work. */
  isSettled(): boolean {
    return this.handle.isSettled();
  }
  liveMessages(session: string): string[] {
    return JSON.parse(this.handle.liveMessages(session)) as string[];
  }
  taskOwner(task: string): string | undefined {
    return this.handle.taskOwner(task) ?? undefined;
  }
  /** True while a native shell still holds its background task open. */
  liveShell(id: string): boolean {
    return this.handle.liveShell(id);
  }
}
