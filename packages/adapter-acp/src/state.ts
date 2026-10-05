import type { InlineRawPayload } from "./data.ts";
import type { TranslatorIdentity } from "./identity.ts";
import { nativeAgentKey } from "./keys.ts";
import type { Fact } from "@ace/core";
import type { InteractionRequest, RawPayload, ToolStatus } from "@ace/protocol";
import { raw, type Data } from "./data.ts";
import type { AcpQuirks } from "./quirks/types.ts";
export interface AgentState {
  key: string;
  nativeId: string;
  parent?: string;
  spawn?: string;
  active: boolean;
  terminal: boolean;
  background: boolean;
  suspended: boolean;
  segment: string;
  inputKey?: string;
  stream?: { key: string; kind: string };
  cancelAt?: number;
  planTool?: ToolState;
  pendingSpawnKey?: string;
}
export interface ToolState {
  nativeId: string;
  inputRaw?: InlineRawPayload;
  initialRaw?: InlineRawPayload;
  originalInput?: Data;
  inputParts?: Map<string, unknown>;
  completedInput?: Data;
  finalized?: boolean;
  uncertainShell?: boolean;
  observedOutput?: string;
  streamedOutput?: string;
  key: string;
  owner: AgentState;
  data: Data;
  status: ToolStatus;
  raw: RawPayload[];
  child?: AgentState;
  task?: string;
  declined: boolean;
}
export interface RequestState {
  key: string;
  method: string;
  params: Data;
  owner: AgentState;
  request: InteractionRequest;
  tool?: ToolState;
}
export class TranslationState {
  readonly agents = new Map<string, AgentState>();
  readonly ownedTools = new Map<string, Map<string, ToolState>>();
  readonly tools = new Map<string, ToolState>();
  readonly uncertainShells = new Map<string, ToolState>();
  readonly liveTools = new Set<ToolState>();
  readonly childBackgroundTools = new Map<string, Set<ToolState>>();
  readonly backgroundTools = new Set<ToolState>();
  readonly pendingChildren = new Map<string, AgentState>();
  readonly childTools = new Map<string, ToolState>();
  readonly requests = new Map<string | number, RequestState>();
  readonly sent = new Map<string | number, { method: string; params: Data }>();
  readonly root: AgentState;
  readonly quirks: AcpQuirks;
  threadId: string;
  cwd = "";
  readonly identity: TranslatorIdentity;
  promptOpen = false;
  stopped = false;
  initialized = false;
  processDead = false;
  constructor(
    rootKey: string,
    quirks: AcpQuirks,
    readonlyThreadId: string,
    identity: TranslatorIdentity,
  ) {
    this.identity = identity;
    this.quirks = quirks;
    this.threadId = readonlyThreadId;
    this.root = {
      key: rootKey,
      nativeId: "",
      active: false,
      terminal: false,
      background: false,
      suspended: false,
      segment: "",
    };
  }
  key(kind: string): string {
    return `${this.root.key}:${JSON.stringify(this.identity.generation)}:${kind}:${++this.identity.cursor}`;
  }
  resetProcess(): void {
    this.promptOpen = false;
    this.sent.clear();
    this.requests.clear();
    this.liveTools.clear();
    this.backgroundTools.clear();
    this.childBackgroundTools.clear();
    this.tools.clear();
    this.ownedTools.clear();
    this.pendingChildren.clear();
    this.childTools.clear();
    for (const agent of new Set([this.root, ...this.agents.values()])) {
      agent.active = false;
      agent.terminal = false;
      agent.suspended = false;
      agent.segment = "";
      delete agent.stream;
      delete agent.cancelAt;
      delete agent.planTool;
    }
    this.agents.clear();
  }
  tool(owner: AgentState, id: string): ToolState | undefined {
    const current = this.ownedTools.get(owner.key)?.get(id);
    if (current) return current;
    const retained = this.uncertainShells.get(JSON.stringify([owner.nativeId, id]));
    if (retained) {
      retained.owner = owner;
      this.registerTool(owner, id, retained);
    }
    return retained;
  }
  retainUncertainShell(tool: ToolState): void {
    tool.uncertainShell = true;
    this.uncertainShells.set(JSON.stringify([tool.owner.nativeId, tool.nativeId]), tool);
  }
  settleShell(tool: ToolState): void {
    delete tool.uncertainShell;
    this.uncertainShells.delete(JSON.stringify([tool.owner.nativeId, tool.nativeId]));
  }
  registerTool(owner: AgentState, id: string, tool: ToolState): void {
    let owned = this.ownedTools.get(owner.key);
    if (!owned) {
      owned = new Map();
      this.ownedTools.set(owner.key, owned);
    }
    owned.set(id, tool);
    this.tools.set(id, tool);
  }
  ensureRoot(facts: Fact[]): void {
    if (this.initialized) return;
    this.initialized = true;
    facts.push({
      type: "agent.seen",
      agent: this.root.key,
      origin: "root",
      fidelity: "full",
      native: {
        provider: this.quirks.provider,
        ...(this.root.nativeId ? { nativeId: this.root.nativeId } : {}),
      },
      cwd: this.cwd,
    });
  }
  agent(id: string, facts: Fact[]): AgentState {
    if (!id || id === this.root.nativeId) return this.root;
    const known = this.agents.get(id);
    if (known) return known;
    const agent: AgentState = {
      key: nativeAgentKey(this.threadId, id),
      nativeId: id,
      parent: this.root.key,
      active: false,
      terminal: false,
      background: false,
      suspended: false,
      segment: "",
    };
    this.agents.set(id, agent);
    facts.push({
      type: "agent.seen",
      agent: agent.key,
      parent: this.root.key,
      origin: "provider_subagent",
      fidelity: "full",
      native: { provider: this.quirks.provider, nativeId: id },
      cwd: this.cwd,
    });
    return agent;
  }
  start(
    agent: AgentState,
    facts: Fact[],
    trigger: "user" | "spawn" | "subagent_result" | "unknown" = "unknown",
  ): void {
    agent.terminal = false;
    facts.push({ type: "agent.reconnected", agent: agent.key });
    if (agent.active) return;
    agent.active = true;
    agent.segment = "";
    facts.push(
      { type: "retry.cleared", agent: agent.key },
      { type: "turn.started", agent: agent.key, nativeTurnId: this.key("turn"), trigger },
    );
  }
  end(
    agent: AgentState,
    facts: Fact[],
    outcome: "completed" | "interrupted" | "failed",
    error?: Extract<Fact, { type: "turn.ended" }>["error"],
  ): void {
    this.finishStream(agent, facts);
    agent.active = false;
    facts.push({ type: "turn.ended", agent: agent.key, outcome, ...(error ? { error } : {}) });
  }
  finishStream(agent: AgentState, facts: Fact[]): void {
    if (!agent.stream) return;
    facts.push({
      type: "item.upsert",
      agent: agent.key,
      item: agent.stream.key,
      draft:
        agent.stream.kind === "agent_thought_chunk"
          ? { type: "reasoning", complete: true }
          : { type: "message", complete: true },
    });
    delete agent.stream;
  }
  notice(facts: Fact[], data: unknown, type: string, text = "ACP frame", owner = this.root): void {
    facts.push({
      type: "item.upsert",
      agent: owner.key,
      item: this.key("raw"),
      draft: { type: "notice", complete: true, level: "info", text, raw: [raw(data, type)] },
    });
  }
}
