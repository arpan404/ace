import type { Fact } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { Frame, Translator } from "./contracts.ts";
import { childUpdate, backgroundChild, placeholderChild, expireChildren } from "./children.ts";
import { list, object, raw, rpcId, string, type Data } from "./data.ts";
import { decodeResolution, interactionKey, interactionRequest } from "./interactions.ts";
import { genericQuirks } from "./quirks/generic.ts";
import type { AcpQuirks } from "./quirks/types.ts";
import { TranslationState, type AgentState, type ToolState } from "./state.ts";
import { toolDetail, toolStatus } from "./tools.ts";

export function createAcpTranslator(
  init: { threadId: ThreadId; rootKey: string },
  quirks: AcpQuirks = genericQuirks,
): Translator {
  return new AcpTranslator(new TranslationState(init.rootKey, quirks));
}
class AcpTranslator implements Translator {
  readonly state: TranslationState;
  constructor(state: TranslationState) {
    this.state = state;
  }
  tick(now: number): Fact[] {
    return expireChildren(this.state, now);
  }
  translate(frame: Frame, now: number): Fact[] {
    const facts: Fact[] = [];
    const s = this.state;
    s.ensureRoot(facts);
    const data = object(frame.data);
    if (frame.dir === "note") {
      if (data["event"] === "stop") s.stopped = true;
      if (data["event"] === "process-start") facts.push({ type: "process.started" });
      if (data["event"] === "process-exit") {
        facts.push({
          type: "process.exited",
          deliberate: s.stopped || object(data["detail"])["deliberate"] === true,
        });
        s.requests.clear();
      }
      if (data["event"] === "queue-changed" && typeof data["count"] === "number")
        facts.push({ type: "queue.changed", count: data["count"] });
      s.notice(facts, frame.data, "recorder");
      return facts;
    }
    if (frame.channel !== "stdio" || frame.dir === "stderr") {
      s.notice(facts, frame.data, frame.channel);
      return facts;
    }
    const method = string(data["method"]);
    const params = object(data["params"]);
    const id = rpcId(data["id"]);
    if (frame.dir === "send" && method) {
      if (id !== undefined) s.sent.set(id, { method, params });
      if (["session/new", "session/load", "session/resume"].includes(method))
        s.cwd = string(params["cwd"]);
      if (method === "session/prompt") {
        const agent = s.agent(string(params["sessionId"]), facts);
        agent.terminal = false;
        s.promptOpen = true;
        s.start(agent, facts, "user");
        facts.push({
          type: "item.upsert",
          agent: agent.key,
          item: s.key("input"),
          draft: {
            type: "message",
            role: "user",
            parts: list(params["prompt"])
              .map(object)
              .filter((p) => p["type"] === "text")
              .map((p) => ({ type: "text", text: string(p["text"]) })),
            complete: true,
            raw: [raw(frame.data, method)],
          },
        });
        return facts;
      }
    }
    if (frame.dir === "recv" && method === "session/update") {
      const agent = s.agent(string(params["sessionId"]), facts);
      if (this.update(agent, object(params["update"]), frame.data, facts)) return facts;
    }
    if (
      frame.dir === "recv" &&
      method &&
      id !== undefined &&
      this.request(id, method, params, frame.data, facts)
    )
      return facts;
    if (!method && id !== undefined) {
      if (frame.dir === "send" && this.answer(id, object(data["result"]), frame.data, facts))
        return facts;
      const sent = frame.dir === "recv" ? s.sent.get(id) : undefined;
      if (sent) {
        s.sent.delete(id);
        const result = object(data["result"]);
        if (
          ["session/new", "session/load", "session/resume"].includes(sent.method) &&
          typeof result["sessionId"] === "string"
        ) {
          s.root.nativeId = result["sessionId"];
          s.agents.set(s.root.nativeId, s.root);
          facts.push({
            type: "agent.seen",
            agent: s.root.key,
            origin: "root",
            fidelity: "full",
            native: { provider: s.quirks.provider, nativeId: s.root.nativeId },
            cwd: s.cwd,
          });
        }
        if (sent.method === "session/prompt") {
          const agent = s.agent(string(sent.params["sessionId"]), facts);
          this.endPrompt(agent, string(result["stopReason"]), object(data["error"]), now, facts);
        }
      }
    }
    s.notice(facts, frame.data, method || "jsonrpc");
    return facts;
  }
  update(agent: AgentState, update: Data, frame: unknown, facts: Fact[]): boolean {
    const s = this.state;
    const kind = string(update["sessionUpdate"]);
    if (childUpdate(s, agent, update, facts)) return true;
    if (kind === "tool_call" || kind === "tool_call_update") {
      const id = string(update["toolCallId"]);
      if (!id) return false;
      let tool = s.tools.get(id);
      if (!tool) {
        tool = {
          key: s.key("tool"),
          owner: agent,
          data: {},
          status: "pending",
          raw: [],
          declined: false,
        };
        s.tools.set(id, tool);
      }
      if (!tool.task) s.start(agent, facts, agent === s.root ? "unknown" : "spawn");
      s.finishStream(agent, facts);
      agent.segment = "";
      tool.data = { ...tool.data, ...update };
      tool.status = tool.declined ? "declined" : toolStatus(update, tool.status);
      tool.raw.push(
        raw(
          frame,
          "session/update",
          string(object(tool.data["rawInput"])["_toolName"] ?? tool.data["name"]),
        ),
      );
      const detail = toolDetail(tool.data, s.quirks);
      facts.push({
        type: "item.upsert",
        agent: agent.key,
        item: tool.key,
        draft: {
          type: "tool_call",
          complete: !["pending", "running", "awaiting_approval"].includes(tool.status),
          call: {
            kind: detail.kind,
            title: string(tool.data["title"]),
            status: tool.status,
            detail: {
              ...detail,
              ...(detail.kind === "agent.spawn" && tool.child
                ? { childAgent: tool.child.key }
                : {}),
            },
            raw: [...tool.raw],
          },
        },
      });
      if (s.quirks.provider === "antigravity" && detail.kind === "agent.spawn")
        placeholderChild(s, tool, facts);
      backgroundChild(s, tool, facts);
      if (
        tool.task &&
        ["succeeded", "failed", "declined", "cancelled"].includes(tool.status) &&
        !tool.child
      )
        facts.push({
          type: "background.ended",
          task: tool.task,
          status:
            tool.status === "succeeded"
              ? "completed"
              : tool.status === "cancelled"
                ? "stopped"
                : "failed",
        });
      if (["succeeded", "failed", "declined", "cancelled"].includes(tool.status))
        facts.push({ type: "activity", agent: agent.key, activity: "starting_turn" });
      return true;
    }
    if (["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"].includes(kind)) {
      if (!agent.suspended && kind !== "user_message_chunk")
        s.start(agent, facts, agent === s.root ? "unknown" : "spawn");
      if (agent.stream?.kind !== kind) {
        s.finishStream(agent, facts);
        agent.stream = { key: s.key("stream"), kind, raw: [] };
      }
      const stream = agent.stream!;
      stream.raw.push(raw(frame, "session/update"));
      const thought = kind === "agent_thought_chunk";
      const content = object(update["content"]);
      facts.push({
        type: "item.upsert",
        agent: agent.key,
        item: stream.key,
        draft: thought
          ? { type: "reasoning", raw: [...stream.raw], complete: false }
          : {
              type: "message",
              role: kind === "user_message_chunk" ? "user" : "assistant",
              raw: [...stream.raw],
              complete: false,
            },
      });
      if (content["type"] === "text") {
        const text = string(content["text"]);
        facts.push({
          type: "item.delta",
          agent: agent.key,
          item: stream.key,
          field: thought ? "reasoning" : "text",
          append: text,
        });
        if (!thought && kind !== "user_message_chunk") agent.segment += text;
      }
      if (
        agent === s.root &&
        kind === "agent_message_chunk" &&
        agent.active &&
        [...s.tools.values()].some(
          (t) => t.owner === agent && t.child?.background && !t.child.terminal,
        ) &&
        ![...s.tools.values()].some(
          (t) =>
            t.owner === agent && ["pending", "running", "awaiting_approval"].includes(t.status),
        )
      ) {
        // Cursor holds prompt responses while the parent waits for background children.
        s.end(agent, facts, "completed");
        agent.suspended = true;
      }
      return true;
    }
    if (kind === "usage_update") {
      const usage = object(update["usage"]);
      const input = usage["inputTokens"];
      const output = usage["outputTokens"];
      if (
        typeof input === "number" &&
        Number.isInteger(input) &&
        input >= 0 &&
        typeof output === "number" &&
        Number.isInteger(output) &&
        output >= 0
      )
        facts.push({ type: "usage", agent: agent.key, inputTokens: input, outputTokens: output });
    }
    return false;
  }
  request(
    id: string | number,
    method: string,
    params: Data,
    frame: unknown,
    facts: Fact[],
  ): boolean {
    const s = this.state;
    const request = interactionRequest(method, params, s.quirks.provider === "antigravity");
    const nativeTool = string(params["toolCallId"] ?? object(params["toolCall"])["toolCallId"]);
    let tool = s.tools.get(nativeTool);
    const owner = tool?.owner ?? s.agent(string(params["sessionId"]), facts);
    if (!request) {
      if (method.startsWith("cursor/") && tool) {
        tool.raw.push(raw(frame, method));
        facts.push({
          type: "item.upsert",
          agent: owner.key,
          item: tool.key,
          draft: { type: "tool_call", call: { raw: [...tool.raw] } },
        });
        return true;
      }
      return false;
    }
    if (!tool && nativeTool) {
      this.update(
        owner,
        {
          ...object(params["toolCall"]),
          toolCallId: nativeTool,
          sessionUpdate: "tool_call",
          kind: request.kind === "plan_review" ? "other" : "other",
          title: string(object(params["toolCall"])["title"]) || method,
          status: "pending",
        },
        frame,
        facts,
      );
      tool = s.tools.get(nativeTool);
    }
    const key = interactionKey(id);
    s.requests.set(id, { key, method, params, owner, request, ...(tool ? { tool } : {}) });
    if (tool) {
      tool.status = "awaiting_approval";
      facts.push({
        type: "item.upsert",
        agent: owner.key,
        item: tool.key,
        draft: { type: "tool_call", call: { status: "awaiting_approval" } },
      });
    }
    facts.push({
      type: "interaction.opened",
      agent: owner.key,
      interaction: key,
      blocking: true,
      request,
      ...(tool ? { item: tool.key } : {}),
      raw: [raw(frame, method)],
    });
    return true;
  }
  answer(id: string | number, result: Data, frame: unknown, facts: Fact[]): boolean {
    const s = this.state;
    const pending = s.requests.get(id);
    if (!pending) return false;
    s.requests.delete(id);
    const resolution = decodeResolution(pending.method, pending.params, result, pending.request);
    facts.push({
      type: "interaction.closed",
      interaction: pending.key,
      state: object(result["outcome"])["outcome"] === "cancelled" ? "cancelled" : "resolved",
      ...(resolution ? { resolution } : {}),
    });
    if (pending.tool) {
      const tool = pending.tool;
      tool.declined =
        (resolution?.kind === "plan_review" && resolution.decision === "reject") ||
        (resolution?.kind === "approval" &&
          pending.request.kind === "approval" &&
          pending.request.options.some(
            (o) => o.id === resolution.optionId && ["deny", "deny_always"].includes(o.kind),
          ));
      tool.status = tool.declined ? "declined" : "running";
      tool.raw.push(raw(frame, pending.method));
      facts.push({
        type: "item.upsert",
        agent: pending.owner.key,
        item: tool.key,
        draft: { type: "tool_call", call: { status: tool.status, raw: [...tool.raw] } },
      });
    }
    return true;
  }
  endPrompt(agent: AgentState, reason: string, error: Data, now: number, facts: Fact[]): void {
    const s = this.state;
    s.promptOpen = false;
    agent.suspended = false;
    const cancelled = reason === "cancelled";
    for (const tool of s.tools.values()) {
      if (!["pending", "running", "awaiting_approval"].includes(tool.status)) continue;
      if (tool.owner !== agent && !cancelled) continue;
      const detail = toolDetail(tool.data, s.quirks);
      if (detail.kind === "shell" && (cancelled || s.quirks.provider === "antigravity")) {
        tool.task ??= s.key("background");
        facts.push({
          type: "background.started",
          agent: tool.owner.key,
          task: tool.task,
          kind: "shell",
          title: string(tool.data["title"]),
          item: tool.key,
          stoppable: false,
          raw: tool.raw,
        });
        if (!cancelled) continue;
        facts.push({ type: "background.ended", task: tool.task, status: "unknown" });
      }
      if (!cancelled && tool.child && !tool.child.terminal) continue;
      tool.status = "cancelled";
      facts.push({
        type: "item.upsert",
        agent: tool.owner.key,
        item: tool.key,
        draft: {
          type: "tool_call",
          complete: true,
          call: { status: "cancelled", error: "turn ended without completion" },
        },
      });
    }
    if (cancelled)
      for (const child of s.agents.values())
        if (child !== s.root && !child.terminal) child.cancelAt = now + 12_000;
    for (const [id, request] of s.requests)
      if (cancelled || request.owner === agent) {
        facts.push({ type: "interaction.closed", interaction: request.key, state: "cancelled" });
        s.requests.delete(id);
      }
    const classified =
      s.quirks.classifyError(agent.segment) ??
      (reason === "refusal"
        ? { kind: "quota" as const, message: "Provider refused the prompt" }
        : undefined) ??
      (Object.keys(error).length
        ? {
            kind: error["code"] === -32000 ? ("auth" as const) : ("provider" as const),
            message: string(error["message"]) || "ACP prompt failed",
          }
        : undefined);
    s.end(
      agent,
      facts,
      cancelled ? "interrupted" : classified ? "failed" : "completed",
      classified,
    );
  }
}
