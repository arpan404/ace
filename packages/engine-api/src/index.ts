import type { LaunchPlan } from "@ace/agent-registry";
import type { Fact, Key } from "@ace/core";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import type { ProviderPayload } from "@ace/provider-kit/payload";
import type {
  Capabilities,
  AcpIdentity,
  AcpSessionSupport,
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
  /** Immutable decoded value admitted from bounded encoded bytes; data must be payload.data. */
  payload?: ProviderPayload;
};

export interface ProviderAdapter {
  readonly provider: ProviderKind;
  /** Probe the installed CLI through provider-kit and report this version's support. */
  capabilities(cli: DiscoveryResult): Capabilities;
  acceptsIdentity?(identity: AcpIdentity): boolean;
  createTranslator(init: {
    threadId: ThreadId;
    rootKey: Key;
    acpIdentity?: AcpIdentity;
  }): Translator;
  openSession(ctx: SessionContext): Promise<ProviderSession>;
  /** Idle provider history clone, bound to this adapter's private home. Never sends input. */
  forkSession?(input: { nativeSessionId: string; signal: AbortSignal }): Promise<string>;
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
  /** Instance-specific environment; adapters must pass it to every owned provider process. */
  env?: NodeJS.ProcessEnv;
  /** Daemon-issued loopback MCP connection, valid only for this session lifetime. */
  aceMcp?: { url: string; bearer: string };
  /** Persist this assignment with the native session ID; resume must reuse the same instance. */
  instanceId?: string;
  model?: string;
  acpIdentity?: AcpIdentity;
  /** Immutable daemon-local plan; wrappers retain it when replacing lifetime signals. */
  acpLaunch?: LaunchPlan;
  mcp?: {
    configuredServers?: readonly unknown[];
    httpServers: readonly unknown[];
    stdioServers?: readonly unknown[];
    secrets: readonly string[];
    end(): void;
  };
  onCapabilities?(capabilities: Capabilities, support?: AcpSessionSupport): void;
  onSessionMetadata?(metadata: unknown): void;
  resume?: { nativeSessionId: string };
  /** Every sent and received frame goes to the engine for translation and persistence. */
  onFrame(frame: Frame): void;
  onExit(exit: { deliberate: boolean; message?: string }): void;
  signal: AbortSignal;
}

/** Configuration owners use these controls; no authentication operations are exposed. */
export interface ProviderMcpControl {
  status(): Promise<unknown>;
  replace(servers: Record<string, unknown>): Promise<unknown>;
  reconnect(name: string): Promise<void>;
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
}
export interface ProviderSession {
  readonly mcp?: ProviderMcpControl;
  readonly instanceId?: string;
  readonly nativeSessionId: string;
  readonly effectiveCapabilities?: Capabilities | undefined;
  readonly acpSupport?: AcpSessionSupport | undefined;
  setModel?(model: string): Promise<void>;
  setMode?(mode: string): Promise<void>;
  /** Optional engine command correlation for providers with durable admission. */
  send(input: ContentPart[], delivery: "steer" | "queue", commandId?: string): Promise<void>;
  interrupt(target: { agent?: Key; cascade: boolean }): Promise<void>;
  resolve(interaction: Key, resolution: InteractionResolution): Promise<void>;
  stopTask(task: Key): Promise<void>;
  close(reason: "idle" | "user" | "shutdown"): Promise<void>;
}
