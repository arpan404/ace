import type { Fact, Key } from "@ace/core";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import type {
  Capabilities,
  ContentPart,
  InteractionResolution,
  ProviderKind,
  ThreadId,
} from "@ace/protocol";

/** Direction from ace's point of view; notes include process exits and interrupts. */
export type FrameDirection = "send" | "recv" | "stderr" | "note";

export type Frame = {
  seq: number;
  /** Milliseconds since the recording or session started. */
  t: number;
  dir: FrameDirection;
  /** Transport-specific channel, such as stdio, sse, http or sdk. */
  channel: string;
  data: unknown;
};

export interface ProviderAdapter {
  readonly provider: ProviderKind;
  /** Probe the installed CLI through provider-kit and report this version's support. */
  capabilities(cli: DiscoveryResult): Capabilities;
  createTranslator(init: { threadId: ThreadId; rootKey: Key }): Translator;
  openSession(ctx: SessionContext): Promise<ProviderSession>;
}

export interface Translator {
  /** Pure and synchronous. Never throws on provider data. */
  translate(frame: Frame, now: number): Fact[];
  /** Facts implied by time passing, including grace windows and wake expiry. */
  tick(now: number): Fact[];
}

export interface SessionContext {
  threadId: ThreadId;
  cwd: string;
  model?: string;
  resume?: { nativeSessionId: string };
  /** Every sent and received frame goes to the engine for translation and persistence. */
  onFrame(frame: Frame): void;
  onExit(exit: { deliberate: boolean; message?: string }): void;
  signal: AbortSignal;
}

export interface ProviderSession {
  readonly nativeSessionId: string;
  send(input: ContentPart[], delivery: "steer" | "queue"): Promise<void>;
  interrupt(target: { agent?: Key; cascade: boolean }): Promise<void>;
  resolve(interaction: Key, resolution: InteractionResolution): Promise<void>;
  stopTask(task: Key): Promise<void>;
  close(reason: "idle" | "user" | "shutdown"): Promise<void>;
}
