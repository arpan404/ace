// SPDX-License-Identifier: Apache-2.0
/**
 * One provider the session bench can drive (E3.0d steps 1-3): its adapter, its synthetic peer
 * and the evidence its native session leaves. A provider module is also its own fake: the
 * driver spawns it with `--fake` when the adapter asks for a child, so one file per provider
 * carries both halves.
 *
 * Codex's slot is `session-stream/codex.ts`, exporting a `BenchProvider` and spawning itself
 * the same way; nothing in the driver or here names it until E3-codex.5 builds it.
 */
import type { Frame, ProviderSession, SessionContext } from "@ace/engine-api";
import type { ContentPart } from "@ace/protocol";

/** What the bench calls of the adapter's translator (`ctx.onFrame` runs it, as the engine does). */
export interface BenchTranslator {
  translate(frame: Frame, now: number): unknown;
  takeDiagnostics?(): unknown;
}

export type BenchMode = "A" | "B" | "C" | "D";

export interface BenchProvider {
  readonly id: "pi" | "acp";
  /** Frames one turn delivers: the fake's lines plus the frames the session itself sends. */
  readonly framesPerTurn: number;
  /** The addon export the sessions mode needs; without it the run is refused, loudly. */
  readonly nativeExport: string;
  /** The switches this provider's four modes set, as `ACE_*` names and values. */
  switches(mode: BenchMode): Record<string, string>;
  /** Files the fake reads before the session opens (Pi's saved history header). */
  prepare(home: string): Promise<void>;
  /** What the session's context hands the child. */
  env(home: string): Record<string, string>;
  /** One turn's input. */
  prompt(turn: number): ContentPart[];
  /** The adapter's translator, run on every frame as the engine runs it. */
  translator(threadId: string): Promise<BenchTranslator>;
  /** The adapter's session open over this module's fake, given the context the driver built. */
  session(home: string): (ctx: SessionContext) => Promise<ProviderSession>;
}
