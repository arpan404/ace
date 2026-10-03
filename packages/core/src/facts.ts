import type {
  ThreadLineage,
  UsageMetadata,
  AgentActivity,
  AgentFidelity,
  AgentOrigin,
  AgentStatus,
  BackgroundTask,
  DeviceId,
  InteractionRequest,
  InteractionResolution,
  Item,
  NativeRef,
  RawPayload,
  RunTrigger,
  ToolCall,
  ToolDetail,
} from "@ace/protocol";

/** Adapter-owned identity, unique within an entity kind and provider process. */
export type Key = string;

type PartialDetail<T> = T extends { kind: "shell" }
  ? Partial<Omit<T, "kind" | "output">> & {
      kind: "shell";
      output?: string;
      outputTruncated?: boolean;
    }
  : T extends { kind: "agent.spawn" }
    ? Partial<Omit<T, "kind" | "childAgentId">> & { kind: "agent.spawn"; childAgent?: Key }
    : T extends { kind: "agent.message" }
      ? Partial<Omit<T, "kind" | "targetAgentId">> & { kind: "agent.message"; targetAgent?: Key }
      : T extends { kind: string }
        ? Partial<Omit<T, "kind">> & Pick<T, "kind">
        : never;

/** Updates may omit existing fields. Legacy output strings become suffix deltas. */
export type ToolDetailDraft = PartialDetail<ToolDetail>;
export type ToolCallDraft = Partial<
  Omit<ToolCall, "id" | "agentId" | "detail" | "backgroundTaskId">
> & { detail?: ToolDetailDraft };

type Draft<T> = T extends { type: "tool_call" }
  ? Partial<Omit<T, "id" | "agentId" | "runId" | "createdAt" | "type" | "call">> & {
      type: "tool_call";
      call?: ToolCallDraft;
    }
  : T extends { type: string }
    ? Partial<Omit<T, "id" | "agentId" | "runId" | "createdAt" | "type">> & Pick<T, "type">
    : never;

export type ItemDraft = Draft<Item>;
export type AgentError = Extract<AgentStatus, { state: "failed" }>["error"];

/**
 * Adapters translate native frames into these facts. Every agent's work must
 * be bracketed by turn.started/turn.ended, including synthesized boundaries
 * for providers without child turns, such as Claude and Cursor. Native keys
 * identify entities; only core allocates ace ids. Providers must report a
 * surviving tool as background.started before ending its owning turn.
 * Adapters should namespace native keys and native turn ids by provider process
 * because providers can restart counters on resume. Pending interaction/task
 * opens are replay-safe; opening a terminal key creates a new ace entity.
 *
 * Partial upserts merge an existing item. A first upsert must supply enough
 * fields to validate the resulting protocol Item. A delta before an upsert
 * creates a minimal streaming item, which later upserts can enrich.
 */
export type Fact =
  | {
      type: "agent.seen";
      agent: Key;
      parent?: Key;
      spawnedBy?: Key;
      origin: AgentOrigin;
      lineage?: ThreadLineage;
      fidelity: AgentFidelity;
      native: NativeRef;
      cwd: string;
      name?: string;
      role?: string;
      model?: string;
      background?: boolean;
    }
  | {
      type: "agent.linked";
      agent: Key;
      parent?: Key;
      spawnedBy?: Key;
      background?: boolean;
      name?: string;
      model?: string;
    }
  /** Durable provider admission transfers queue ownership; it is not a model turn. */
  | { type: "input.admitted"; agent: Key; nativeInputId: string; commandId?: string }
  | { type: "turn.started"; agent: Key; nativeTurnId?: string; trigger: RunTrigger }
  | {
      type: "turn.ended";
      agent: Key;
      nativeTurnId?: string;
      outcome: "completed" | "interrupted" | "failed";
      trigger?: RunTrigger;
      error?: AgentError;
    }
  /** A live native wait tool blocks on targets, or all live children when targets is empty. */
  | { type: "subagents.waiting"; agent: Key; item: Key; targets: Key[] }
  | { type: "activity"; agent: Key; activity: AgentActivity; detail?: string }
  | { type: "item.upsert"; agent: Key; item: Key; draft: ItemDraft }
  /** Idempotent snapshot reconciliation: preserve completion, first raw input and output prefixes. */
  | { type: "item.reconciled"; agent: Key; item: Key; draft: ItemDraft }
  | {
      type: "item.delta";
      agent: Key;
      item: Key;
      field: "text" | "reasoning" | "output";
      append: string;
    }
  | {
      type: "interaction.opened";
      agent: Key;
      interaction: Key;
      blocking: boolean;
      request: InteractionRequest;
      item?: Key;
      raw?: RawPayload[];
    }
  | {
      type: "interaction.closed";
      interaction: Key;
      state: "resolved" | "cancelled" | "expired";
      resolution?: InteractionResolution;
      resolvedBy?: DeviceId;
    }
  | {
      type: "background.started";
      agent: Key;
      task: Key;
      kind: BackgroundTask["kind"];
      title: string;
      item?: Key;
      childAgent?: Key;
      ambient?: boolean;
      stoppable: boolean;
      outputPath?: string;
      raw?: RawPayload[];
    }
  | {
      type: "background.ended";
      task: Key;
      status: "completed" | "failed" | "stopped" | "unknown";
      /** Unknown execution still holds completion until explicit terminal evidence. */
      uncertain?: boolean;
    }
  | {
      type: "retry";
      agent: Key;
      on: "rate_limit" | "network" | "upstream";
      attempt?: number;
      until?: number;
      message?: string;
    }
  | { type: "agent.disconnected"; agent: Key }
  | { type: "agent.reconnected"; agent: Key }
  | { type: "retry.cleared"; agent: Key }
  | { type: "wake.expected"; agent: Key; until: number }
  | ({
      type: "usage";
      agent: Key;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      contextWindow?: number;
      costUsd?: number;
    } & UsageMetadata)
  | { type: "signal"; agent?: Key }
  | { type: "process.started" }
  | { type: "process.exited"; deliberate: boolean; message?: string }
  | { type: "queue.changed"; count: number; source?: "engine" | "provider" }
  | { type: "tick" };

export type AgentSeenFact = Extract<Fact, { type: "agent.seen" }>;
export type AgentLinkedFact = Extract<Fact, { type: "agent.linked" }>;
export type RootAgentInit = Omit<AgentSeenFact, "type" | "parent" | "spawnedBy" | "origin">;
