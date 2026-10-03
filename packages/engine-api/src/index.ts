import type { Fact, Key } from "@ace/core";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import type { ProviderPayload } from "@ace/provider-kit/payload";

export type ProviderBackend = "cursor-sdk" | "acp";
export type SdkDiscovery = {
  installed: boolean;
  module?: string;
  version?: string;
  supported: boolean;
  error?: string;
};
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
  payload?: ProviderPayload;
};

export interface ProviderAdapter {
  readonly provider: ProviderKind;
  readonly backend?: ProviderBackend;
  /** Probe the installed CLI through provider-kit and report this version's support. */
  capabilities(cli: DiscoveryResult): Capabilities;
  createTranslator(init: { threadId: ThreadId; rootKey: Key }): Translator;
  openSession(ctx: SessionContext): Promise<ProviderSession>;
}

export interface Translator {
  /** Combine with core.nextDeadline(state, translator.nextDeadline?.()). */
  nextDeadline?(): number | undefined;
  /** Pure and synchronous. Never throws on provider data. */
  translate(frame: Frame, now: number): Fact[];
  /** Facts implied by time passing, including grace windows and wake expiry. */
  tick(now: number): Fact[];
}

export interface SessionContext {
  /** Engine root identity, also used by targeted interrupts. */
  rootKey?: Key;
  threadId: ThreadId;
  cwd: string;
  model?: string;
  instanceId?: string;
  /** Host-local selected account home, never a client-supplied credential selector. */
  instanceHomeDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimePolicy?: "restricted" | "full-access";
  resume?: { nativeSessionId: string; backend?: ProviderBackend; instanceId?: string };
  /** Every sent and received frame goes to the engine for translation and persistence. */
  onFrame(frame: Frame): void;
  onExit(exit: { deliberate: boolean; message?: string }): void;
  signal: AbortSignal;
}

export interface ProviderSession {
  readonly nativeSessionId: string;
  readonly backend?: ProviderBackend;
  readonly instanceId?: string;
  send(
    input: ContentPart[],
    delivery: "steer" | "queue",
    intent?: { operationId: string },
  ): Promise<void>;
  interrupt(target: { agent?: Key; cascade: boolean }): Promise<void>;
  resolve(interaction: Key, resolution: InteractionResolution): Promise<void>;
  stopTask(task: Key): Promise<void>;
  close(reason: "idle" | "user" | "shutdown"): Promise<void>;
}
