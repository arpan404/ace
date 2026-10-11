import type { LaunchPlan } from "@ace/agent-registry";
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
  ExecutionOptions,
  ExecutionSelection,
  Capabilities,
  PermissionMode,
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
  /** Account shell captures safe attribution when it admits the frame, before deferred folding. */
  usageAccount?: { id: string; billingMode: "api" | "subscription" | "unknown" } | undefined;
};

export interface ProviderAdapter {
  readonly provider: ProviderKind;
  readonly backend?: ProviderBackend;
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
  /** Native debug evidence kept outside the transcript. Drain after each translation. */
  takeDiagnostics?(): import("@ace/protocol").RawPayload[];
  /** Combine with core.nextDeadline(state, translator.nextDeadline?.()). */
  nextDeadline?(): number | undefined;
  /** Pure and synchronous. Never throws on provider data. */
  translate(frame: Frame, now: number): Fact[];
  /** Facts implied by time passing, including grace windows and wake expiry. */
  tick(now: number): Fact[];
}

export interface SessionContext {
  /** Backpressure shared by stdout, stderr, SDK iterators and HTTP streams. */
  outputFlow?: import("@ace/provider-kit/flow-control").OutputFlow;
  /** Engine root identity, also used by targeted interrupts. */
  rootKey?: Key;
  threadId: ThreadId;
  cwd: string;
  /** Instance-specific environment; adapters must pass it to every owned provider process. */
  env?: NodeJS.ProcessEnv;
  /** Persist this assignment with the native session ID; resume must reuse the same instance. */
  instanceId?: string;
  model?: string;
  /** Daemon-owned executable override; never accepted from wire session data. */
  executable?: string;
  /** Host-local selected account home, never a client-supplied credential selector. */
  instanceHomeDir?: string;
  /** Required by the engine; omitted only by legacy direct callers. */
  permissionMode?: PermissionMode;
  runtimePolicy?: "restricted" | "full-access";
  resume?: {
    nativeSessionId: string;
    backend?: ProviderBackend;
    instanceId?: string;
    afterFrameOffset?: number;
  };
  /** Persist selection before host admission and native identity before publishing its open frame. */
  onSessionIdentity?(identity: {
    backend: ProviderBackend;
    instanceId: string;
    nativeSessionId?: string;
  }): void;
  /** Persist host command/native message correlation before input can be echoed or replayed.
   * Report every command, including ordinary user input; text never establishes ace origin.
   * The native ID must match the projected user message's draft.nativeId.
   */
  /** Native transcript exists and may now be resumed after this process closes. */
  onSessionConfirmed?(nativeSessionId: string): void;
  onInputMessage?(identity: { commandId: string; nativeId: string }): void;
  /** Ephemeral ace capability, revoked with this session. Never persisted. */
  aceMcp?: { url: string; bearer: string; signal?: AbortSignal; end?(): void };
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
  /** Exclusive with resume. Inclusive provider-native boundary; never a guessed canonical ID. */
  fork?: { nativeSessionId: string; point: { type: "turn" | "item" | "end"; nativeId: string } };
  options?: ExecutionOptions;
  /** Every sent and received frame goes to the engine for translation and persistence. */
  /** A returned promise acknowledges durable storage; its resolved value is ignored. */
  onFrame(frame: Frame): unknown;
  onExit(exit: { deliberate: boolean; message?: string }): void;
  signal: AbortSignal;
}

/** Configuration owners use these controls; no authentication operations are exposed. */
export interface ProviderMcpControl {
  status(): Promise<unknown>;
  add?(name: string, server: import("@ace/protocol").McpServerInput): Promise<void>;
  readonly appliesNextTurn?: boolean;
  replace(servers: Record<string, unknown>): Promise<unknown>;
  reconnect(name: string): Promise<void>;
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
}
export interface ProviderSession {
  readonly mcp?: ProviderMcpControl;
  readonly instanceId?: string;
  readonly nativeSessionId: string;
  /** False until the provider confirms a resumable transcript exists. */
  readonly sessionConfirmed?: boolean;
  readonly backend?: ProviderBackend;
  configure?(selection: ExecutionSelection): Promise<void>;
  readonly effectiveCapabilities?: Capabilities | undefined;
  readonly acpSupport?: AcpSessionSupport | undefined;
  setModel?(model: string): Promise<void>;
  setMode?(mode: string): Promise<void>;
  /** Optional engine command correlation for providers with durable admission. */
  send(
    input: ContentPart[],
    delivery: "steer" | "queue",
    commandId?: string,
    origin?: "ace",
  ): Promise<void>;
  interrupt(target: { agent?: Key; cascade: boolean }): Promise<void>;
  resolve(interaction: Key, resolution: InteractionResolution): Promise<void>;
  stopTask(task: Key): Promise<void>;
  close(reason: "idle" | "user" | "shutdown"): Promise<void>;
}
