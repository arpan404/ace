import { createHash } from "node:crypto";
import type { TranslatorIdentity } from "./identity.ts";
import { promptStop } from "./settlement.ts";
import { retainToolRaw } from "./tool-raw.ts";
import { currentToolDetail, finalizeTool } from "./tool-final.ts";
import { retireTool, renewTool } from "./completed-tools.ts";
import { ShellOutput } from "./shell-output.ts";
import { decodeContent } from "./content.ts";
import type { Fact } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { Frame, Translator } from "@ace/engine-api";
import { childUpdate, backgroundChild, placeholderChild, expireChildren } from "./children.ts";
import { list, object, raw, rpcId, string, type Data } from "./data.ts";
import { openRequest, answerRequest } from "./requests.ts";
import { genericQuirks } from "./quirks/generic.ts";
import type { AcpQuirks } from "./quirks/types.ts";
import { TranslationState, type AgentState } from "./state.ts";
import { endPrompt } from "./lifecycle.ts";
import { toolDetail, toolError, toolStatus, toolTitle, todos, mergeToolData } from "./tools.ts";

const errorKey = (text: string) => createHash("sha256").update(text).digest("hex");
export function createAcpTranslator(
  init: { threadId: ThreadId; rootKey: string; identity: TranslatorIdentity },
  quirks: AcpQuirks = genericQuirks,
): Translator {
  return new AcpTranslator(
    new TranslationState(init.rootKey, quirks, init.threadId, init.identity),
  );
}
class AcpTranslator implements Translator {
  readonly state: TranslationState;
  private inputNativeId: string | undefined;
  private readonly shellOutput = new ShellOutput();
  /** A digest of the failure text each tool's row last showed. */
  private readonly publishedErrors = new WeakMap<object, string>();
  /** Each agent's plan row for its current turn, when it has no plan tool. */
  private readonly plans = new WeakMap<AgentState, { turn: string; key: string }>();
  constructor(state: TranslationState) {
    this.state = state;
  }
  takeDiagnostics() {
    const pending = this.state.diagnostics;
    this.state.diagnostics = [];
    return pending;
  }
  tick(now: number): Fact[] {
    return this.state.processDead ? [] : expireChildren(this.state, now);
  }
  translate(frame: Frame, now: number): Fact[] {
    const facts: Fact[] = [];
    const s = this.state;
    s.diagnostics = [];
    s.ensureRoot(facts);
    const data = object(frame.data);
    if (frame.dir === "note") {
      if (data["event"] === "stop") s.stopped = true;
      if (data["event"] === "process-start") {
        this.inputNativeId = undefined;
        s.resetProcess();
        s.stopped = false;
        s.processDead = false;
        facts.push({ type: "process.started" });
      }
      if (data["event"] === "process-exit") {
        facts.push({
          type: "process.exited",
          deliberate: s.stopped || object(data["detail"])["deliberate"] === true,
        });
        s.resetProcess();
        s.processDead = true;
      }
      if (data["event"] === "queue-changed" && typeof data["count"] === "number")
        facts.push({ type: "queue.changed", count: data["count"] });
      if (data["event"] === "input-sending") {
        this.inputNativeId = string(data["nativeId"]);
        return facts;
      }
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
      if (["session/new", "session/load", "session/resume"].includes(method)) {
        s.cwd = string(params["cwd"]);
        if (typeof params["sessionId"] === "string") s.bindRoot(params["sessionId"], facts);
      }
      if (method === "session/prompt") {
        const agent = s.agent(string(params["sessionId"]), facts);
        agent.terminal = false;
        s.promptOpen = true;
        s.start(agent, facts, "user");
        agent.inputKey = s.key("input");
        facts.push({
          type: "item.upsert",
          agent: agent.key,
          item: agent.inputKey,
          draft: {
            type: "message",
            role: "user",
            ...(this.inputNativeId ? { nativeId: this.inputNativeId } : {}),
            parts: list(params["prompt"]).flatMap(decodeContent),
            complete: true,
            raw: [raw(frame.data, method)],
          },
        });
        this.inputNativeId = undefined;
        return facts;
      }
    }
    if (frame.dir === "recv" && method === "session/update") {
      if ([...s.sent.values()].some((request) => request.method === "session/load")) {
        s.diagnostics.push(raw(frame.data, "session/load replay"));
        return facts;
      }
      const agent = s.agent(string(params["sessionId"]), facts);
      if (this.update(agent, object(params["update"]), frame.data, facts)) return facts;
    }
    if (
      frame.dir === "recv" &&
      method &&
      id !== undefined &&
      openRequest(s, id, method, params, frame.data, facts, (owner, update) =>
        this.update(owner, update, frame.data, facts),
      )
    )
      return facts;
    if (!method && id !== undefined) {
      if (
        frame.dir === "send" &&
        "result" in data &&
        answerRequest(s, id, object(data["result"]), frame.data, facts)
      )
        return facts;
      const sent = frame.dir === "recv" ? s.sent.get(id) : undefined;
      if (sent) {
        const result = object(data["result"]);
        if (
          sent.method === "session/prompt" &&
          data["error"] === undefined &&
          promptStop(result) === undefined
        ) {
          s.notice(
            facts,
            frame.data,
            "jsonrpc",
            "Unrecognized ACP prompt response; completion unconfirmed",
          );
          return facts;
        }
        s.sent.delete(id);
        if (
          ["session/new", "session/load", "session/resume"].includes(sent.method) &&
          typeof result["sessionId"] === "string"
        )
          s.bindRoot(result["sessionId"], facts);
        if (
          ["session/load", "session/resume"].includes(sent.method) &&
          s.root.active &&
          !s.promptOpen
        )
          s.end(s.root, facts, "completed");
        if (sent.method === "session/prompt") {
          const agent = s.agent(string(sent.params["sessionId"]), facts);
          endPrompt(s, agent, string(result["stopReason"]), object(data["error"]), now, facts);
        }
      }
    }
    s.notice(facts, frame.data, method || "jsonrpc");
    return facts;
  }
  /**
   * A standard plan update from an agent with no plan tool (TodoWrite, update_plan, todos): the
   * plan is its own todo row, one per turn, replaced in place as the agent revises it.
   */
  plan(agent: AgentState, update: Data, frame: unknown, facts: Fact[]): boolean {
    const s = this.state;
    const turn = agent.inputKey ?? "";
    let plan = this.plans.get(agent);
    if (plan?.turn !== turn) {
      s.finishStream(agent, facts);
      plan = { turn, key: s.key("plan") };
      this.plans.set(agent, plan);
    }
    facts.push({
      type: "item.upsert",
      agent: agent.key,
      item: plan.key,
      draft: {
        type: "tool_call",
        complete: true,
        call: {
          kind: "todo",
          title: "Plan",
          status: "succeeded",
          detail: { kind: "todo", todos: todos(update["entries"]) },
          raw: [raw(frame, "session/update")],
        },
      },
    });
    return true;
  }
  update(agent: AgentState, update: Data, frame: unknown, facts: Fact[]): boolean {
    const s = this.state;
    const kind = string(update["sessionUpdate"]);
    if (
      kind === "session_info_update" &&
      agent.key === s.root.key &&
      typeof update["title"] === "string"
    ) {
      facts.push({
        type: "item.upsert",
        agent: agent.key,
        item: "provider:title",
        draft: {
          type: "notice",
          code: "thread_title",
          title: update["title"],
          text: update["title"],
          level: "info",
          complete: true,
        },
      });
      s.notice(facts, frame, "session/update", undefined, agent);
      return true;
    }
    if (childUpdate(s, agent, update, frame, facts)) return true;
    if (kind === "tool_call" || kind === "tool_call_update") {
      const id = string(update["toolCallId"]);
      if (!id) return false;
      let tool = s.tool(agent, id);
      const retainedRaw = tool?.retired === true && !Object.hasOwn(update, "rawInput");
      const priorStatus = tool?.status;
      const priorDefinition = tool && {
        title: tool.data["title"],
        name: tool.data["name"],
        kind: tool.data["kind"],
      };
      const priorOutput = object(tool?.data["rawOutput"]);
      if (!tool) {
        tool = {
          nativeId: id,
          key: s.key("tool"),
          owner: agent,
          data: {},
          status: "pending",
          raw: [],
          declined: false,
        };
        s.registerTool(agent, id, tool);
      }
      const pendingChild = s.pendingChildren.get(JSON.stringify([agent.key, id]));
      if (pendingChild) {
        tool.child = pendingChild;
        pendingChild.spawn = tool.key;
        delete pendingChild.pendingSpawnKey;
        s.childTools.set(pendingChild.nativeId, tool);
        s.pendingChildren.delete(JSON.stringify([agent.key, id]));
        facts.push({
          type: "agent.linked",
          agent: pendingChild.key,
          parent: agent.key,
          spawnedBy: tool.key,
        });
      }
      mergeToolData(tool.data, update);
      tool.status = tool.declined ? "declined" : toolStatus(update, tool.status);
      retainToolRaw(
        tool,
        raw(
          frame,
          "session/update",
          string(object(tool.data["rawInput"])["_toolName"] ?? tool.data["name"]),
        ),
        update,
      );
      if (["pending", "running", "awaiting_approval"].includes(tool.status)) s.liveTools.add(tool);
      else s.liveTools.delete(tool);
      const live = s.liveTools.has(tool);
      if (live) renewTool(s, tool);
      const definitionChanged =
        Object.hasOwn(update, "content") ||
        Object.hasOwn(update, "_meta") ||
        ["title", "name", "kind"].some(
          (key) => typeof update[key] === "string" && update[key] !== object(priorDefinition)[key],
        ) ||
        (tool.finalized && tool.completedInput === undefined) ||
        Object.entries(object(update["rawOutput"])).some(
          ([key, value]) =>
            ["exitCode", "totalFiles", "isBackground"].includes(key) && value !== priorOutput[key],
        );
      if (definitionChanged) renewTool(s, tool);
      const error = tool.status === "failed" ? toolError(update) : undefined;
      // A failed update that brings new failure text reaches the row; text on an update that
      // doesn't say it failed stays in diagnostics. Digests, so no native payload is kept.
      const errorDigest = error === undefined ? undefined : errorKey(error);
      const newError =
        update["status"] === "failed" &&
        errorDigest !== undefined &&
        errorDigest !== this.publishedErrors.get(tool);
      if (
        tool.finalized &&
        !tool.uncertainShell &&
        !pendingChild &&
        !definitionChanged &&
        !newError &&
        priorStatus === tool.status
      ) {
        s.notice(facts, frame, "session/update", undefined, agent);
        if (toolDetail(tool.data, s.quirks).kind === "shell")
          this.shellOutput.append(s, tool, update, facts);
        retireTool(s, tool);
        return true;
      }
      if (retainedRaw) s.notice(facts, frame, "session/update", undefined, agent);
      if (!tool.task && (priorStatus === undefined || live || !tool.finalized))
        s.start(agent, facts, agent === s.root ? "unknown" : "spawn");
      s.finishStream(agent, facts);
      agent.segment = "";
      const detail = live ? currentToolDetail(tool, s.quirks) : finalizeTool(tool, s.quirks);
      if (errorDigest) this.publishedErrors.set(tool, errorDigest);
      facts.push({
        type: "item.upsert",
        agent: agent.key,
        item: tool.key,
        draft: {
          type: "tool_call",
          complete: !["pending", "running", "awaiting_approval"].includes(tool.status),
          call: {
            kind: detail.kind,
            title: toolTitle(tool.data, detail),
            status: tool.status,
            ...(error ? { error } : {}),
            detail: {
              ...detail,
              ...(detail.kind === "agent.spawn" && tool.child
                ? { childAgent: tool.child.key }
                : {}),
            },
            ...(!retainedRaw ? { raw: [...tool.raw] } : {}),
          },
        },
      });
      if (detail.kind === "shell") this.shellOutput.append(s, tool, update, facts);
      if (detail.kind === "plan") agent.planTool = tool;
      if (s.quirks.provider === "antigravity" && detail.kind === "agent.spawn")
        placeholderChild(s, tool, facts);
      backgroundChild(s, tool, facts);
      if (
        tool.task &&
        ["succeeded", "failed", "declined", "cancelled"].includes(tool.status) &&
        !tool.child
      ) {
        s.settleShell(tool);
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
      }
      if (["succeeded", "failed", "declined", "cancelled"].includes(tool.status))
        facts.push({ type: "activity", agent: agent.key, activity: "starting_turn" });
      retireTool(s, tool);
      return true;
    }
    if (["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"].includes(kind)) {
      if (kind === "user_message_chunk" && agent.inputKey && s.promptOpen) {
        // The outgoing prompt is authoritative; streamed echoes retain raw data only.
        facts.push({
          type: "item.reconciled",
          agent: agent.key,
          item: agent.inputKey,
          draft: { type: "message", role: "user", raw: [raw(frame, "session/update")] },
        });
        return true;
      }
      if (!agent.suspended && kind !== "user_message_chunk")
        s.start(agent, facts, agent === s.root ? "unknown" : "spawn");
      const content = object(update["content"]);
      if (content["type"] !== "text") s.finishStream(agent, facts);
      if (agent.stream?.kind !== kind) {
        s.finishStream(agent, facts);
        agent.stream = { key: s.key("stream"), kind };
      }
      const stream = agent.stream;
      if (!stream) return false;

      const thought = kind === "agent_thought_chunk";
      facts.push({
        type: "item.upsert",
        agent: agent.key,
        item: stream.key,
        draft: thought
          ? { type: "reasoning", raw: [raw(frame, "session/update")], complete: false }
          : {
              type: "message",
              role: kind === "user_message_chunk" ? "user" : "assistant",
              ...(content["type"] !== "text" ? { parts: decodeContent(content) } : {}),
              raw: [raw(frame, "session/update")],
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
        if (!thought && kind !== "user_message_chunk")
          agent.segment += text.slice(0, Math.max(0, 8192 - agent.segment.length));
      }
      if (
        agent === s.root &&
        kind === "agent_message_chunk" &&
        agent.active &&
        [...s.backgroundTools].some(
          (t) => t.owner === agent && t.child?.background && !t.child.terminal,
        ) &&
        ![...s.liveTools].some(
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
    if (kind === "plan" && agent.planTool) {
      const tool = agent.planTool;
      retainToolRaw(tool, raw(frame, "session/update"), update);
      facts.push({
        type: "item.upsert",
        agent: agent.key,
        item: tool.key,
        draft: {
          type: "tool_call",
          call: { detail: { kind: "plan", todos: todos(update["entries"]) }, raw: [...tool.raw] },
        },
      });
      return true;
    }
    if (kind === "plan") return this.plan(agent, update, frame, facts);
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
}
