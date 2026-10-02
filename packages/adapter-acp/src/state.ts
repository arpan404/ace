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
  stream?: { key: string; kind: string; raw: RawPayload[] };
  cancelAt?: number;
}
export interface ToolState {
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
  readonly tools = new Map<string, ToolState>();
  readonly requests = new Map<string | number, RequestState>();
  readonly sent = new Map<string | number, { method: string; params: Data }>();
  readonly root: AgentState;
  readonly quirks: AcpQuirks;
  cwd = "";
  sequence = 0;
  promptOpen = false;
  stopped = false;
  initialized = false;
  constructor(rootKey: string, quirks: AcpQuirks) {
    this.quirks = quirks;
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
    return `${this.root.key}:${kind}:${++this.sequence}`;
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
      key: this.key("agent"),
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
    if (agent.active || agent.terminal) return;
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
