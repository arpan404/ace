import { unknownBuffers, RecentSet } from "./retention.ts";
import type { Fact, Key } from "@ace/core";
import type { ThreadId, RunTrigger } from "@ace/protocol";
import type { Frame, Translator } from "@ace/engine-api";
import type { Agent, TranslationContext } from "./translator-state.ts";
import { createAgentRegistry } from "./agent-registry.ts";
import { completeTurn } from "./translate-turn.ts";
import { translateItem } from "./translate-item.ts";
import { isKnownDelta, translateDelta } from "./translate-delta.ts";
import { openRequest, turnError } from "./interactions.ts";
import { asyncKey, list, obj, raw, requestKey, str, type Obj } from "./native.ts";

const requestMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

export function createCodexTranslator(init: { threadId: ThreadId; rootKey: Key }): Translator {
  const agents = new Map<string, Agent>();
  const sent = new Map<string, { method: string; params: Obj; interaction?: string }>();
  let recordedAnswer: string | undefined;
  const userTurns = new RecentSet();
  const buffers = unknownBuffers();

  let root = "";
  let cwd = "";
  const { ensure, discover } = createAgentRegistry({
    agents,
    rootKey: init.rootKey,
    getRoot: () => root,
    getCwd: () => cwd,
    replay: handle,
    takeBuffer: buffers.take,
  });
  const translation: TranslationContext = {
    agents,
    tasks: new Set(),
    discover,
    note: (...args) => note(...args),
  };
  let synthetic = 0;
  let deliberate = false;
  const note = (agent: Key, type: string, data: unknown, text = type): Fact => ({
    type: "item.upsert",
    agent,
    item: `codex:raw:${++synthetic}`,
    draft: { type: "notice", level: "info", text, complete: true, raw: raw(type, data) },
  });
  function handle(frame: Frame, now: number): Fact[] {
    const facts: Fact[] = [];
    const message = obj(frame.data),
      p = obj(message["params"]),
      method = str(message["method"]);
    const id = message["id"];
    if (frame.dir === "note") {
      if (message["event"] === "thread-discovered") {
        const thread = obj(message["thread"]);
        const source = obj(obj(obj(thread["source"])["subAgent"])["thread_spawn"]);
        discover(
          str(thread["id"]),
          thread,
          facts,
          now,
          str(thread["parentThreadId"], str(source["parent_thread_id"])) || undefined,
        );
      }
      // Recorded fixtures explicitly annotate an answer; ambiguous annotations close nothing.
      if (message["event"] === "async-question-answered") {
        const questions = [...agents.values()].flatMap((a) => [...a.async].map(asyncKey));
        if (questions.length === 1) recordedAnswer = questions[0];
      }
      if (message["event"] === "discovery-start")
        facts.push({
          type: "background.started",
          agent: init.rootKey,
          task: str(message["task"], "codex:discovery"),
          kind: "other",
          title: "Discovering loaded descendants",
          stoppable: false,
        });
      if (message["event"] === "discovery-finished")
        facts.push({
          type: "background.ended",
          task: str(message["task"], "codex:discovery"),
          status: "completed",
        });
      if (message["event"] === "queue-state" && typeof message["count"] === "number")
        facts.push({ type: "queue.changed", count: message["count"] });
      if (message["event"] === "stop") deliberate = true;
      if (message["event"] === "process-exit")
        facts.push({ type: "process.exited", deliberate, message: "Codex app-server exited" });
      if (message["event"] === "interaction-resolved") {
        for (const agent of agents.values())
          for (const item of agent.async)
            if (asyncKey(item) === message["interaction"]) agent.async.delete(item);
        facts.push({
          type: "interaction.closed",
          interaction: str(message["interaction"]),
          state: "resolved",
        });
      }
      return facts;
    }
    if (frame.dir === "send") {
      if (method && id !== undefined) {
        sent.set(requestKey(id), {
          method,
          params: p,
          ...(recordedAnswer && ["turn/start", "turn/steer"].includes(method)
            ? { interaction: recordedAnswer }
            : {}),
        });
        recordedAnswer = undefined;
      }
      if (method === "thread/start") cwd = str(p["cwd"]);
      if (method === "turn/start") {
        const agent = agents.get(str(p["threadId"]));
        if (agent && p["collaborationMode"])
          agent.mode = str(obj(p["collaborationMode"])["mode"], agent.mode);
      }
      facts.push(note(init.rootKey, method || "rpc.response.sent", frame.data));
      return facts;
    }
    if (frame.dir === "stderr") {
      return [note(init.rootKey, "stderr", frame.data, str(frame.data))];
    }
    if (!method && id !== undefined) {
      const pending = sent.get(requestKey(id));
      sent.delete(requestKey(id));
      const result = obj(message["result"]);
      const thread = obj(result["thread"]);
      if (pending?.method === "initialize" && message["error"] === undefined)
        facts.push({ type: "process.started" });
      if (pending?.method === "thread/start" || pending?.method === "thread/resume") {
        if (str(thread["id"])) {
          root = str(thread["id"]);
          cwd = str(thread["cwd"], str(pending.params["cwd"], cwd));
          discover(root, thread, facts, now);
        }
      } else if (
        pending?.method === "thread/read" &&
        frame.channel !== "codex-discovery" &&
        str(thread["id"])
      ) {
        const source = obj(obj(obj(thread["source"])["subAgent"])["thread_spawn"]);
        discover(
          str(thread["id"]),
          thread,
          facts,
          now,
          str(thread["parentThreadId"], str(source["parent_thread_id"])) || undefined,
        );
      } else if (pending?.method === "turn/start" && message["error"] === undefined) {
        userTurns.add(str(obj(result["turn"])["id"]));
      }
      if (pending?.interaction && message["error"] === undefined) {
        facts.push({
          type: "interaction.closed",
          interaction: pending.interaction,
          state: "resolved",
        });
        for (const agent of agents.values())
          for (const item of agent.async)
            if (asyncKey(item) === pending.interaction) agent.async.delete(item);
      }
      facts.push(note(init.rootKey, "rpc.response", frame.data));
      return facts;
    }
    if (method === "thread/started") {
      const thread = obj(p["thread"]);
      const native = str(thread["id"]);
      if (!native) return root ? [note(init.rootKey, method, frame.data)] : [];
      if (!root) root = native;
      discover(native, thread, facts, now, str(thread["parentThreadId"]) || undefined);
      facts.push(note(init.rootKey, method, frame.data));
      return facts;
    }
    const native = str(p["threadId"], root);
    if (!native) {
      return [note(init.rootKey, method || "unknown", frame.data)];
    }
    const agent = ensure(native, native === root, facts);
    facts.push({ type: "signal", agent: agent.key });
    if (!agent.known) {
      if (!agent.unknownTask) {
        agent.unknownTask = true;
        facts.push({
          type: "background.started",
          agent: init.rootKey,
          task: `unknown:${native}`,
          kind: "other",
          title: "Discovering an unknown Codex thread",
          stoppable: false,
        });
      }
      facts.push(note(agent.key, method || "unknown", frame.data));
      buffers.push(agent, frame);
      return facts;
    }
    if (
      [
        "turn/started",
        "turn/completed",
        "thread/status/changed",
        "thread/settings/updated",
        "thread/tokenUsage/updated",
        "thread/queue/changed",
        "thread/goal/updated",
        "thread/goal/cleared",
      ].includes(method)
    )
      facts.push(note(agent.key, method, frame.data));
    if (requestMethods.has(method) && id !== undefined) {
      const key = requestKey(id);
      const item = str(p["itemId"]);
      facts.push(...openRequest(agent.key, key, method, p, agent.items.has(item)));
      if (item) agent.items.add(item);
      agent.requests.set(key, { item, turn: str(p["turnId"], agent.turn) });
      delete agent.unmatchedFlag;
      facts.push({
        type: "interaction.closed",
        interaction: `status:${native}`,
        state: "cancelled",
      });
    } else if (method === "serverRequest/resolved") {
      const key = requestKey(p["requestId"]);
      facts.push({ type: "interaction.closed", interaction: key, state: "resolved" });
      const item = agent.requests.get(key)?.item;
      if (item && !agent.open.has(item))
        facts.push({
          type: "item.upsert",
          agent: agent.key,
          item,
          draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
        });
      agent.requests.delete(key);
    } else if (method === "turn/started") {
      const turn = str(obj(p["turn"])["id"]);
      agent.turn = turn;
      agent.hadTurn = true;
      delete agent.plan;
      delete agent.failureText;
      const trigger: RunTrigger = userTurns.has(turn)
        ? "user"
        : agent.parent
          ? (agent.pendingTrigger ?? "spawn")
          : agent.childResult
            ? "subagent_result"
            : agent.backgroundResult
              ? "background_completion"
              : (agent.pendingTrigger ?? "unknown");
      userTurns.delete(turn);
      agent.childResult = false;
      agent.backgroundResult = false;
      delete agent.pendingTrigger;
      facts.push({ type: "turn.started", agent: agent.key, nativeTurnId: turn, trigger });
    } else if (method === "turn/completed") {
      completeTurn(agent, native, p, translation, facts);
      if (agent.unmatchedFlag)
        facts.push({
          type: "interaction.opened",
          agent: agent.key,
          interaction: `status:${native}`,
          blocking: true,
          request: { kind: "approval", title: "Codex is waiting for input", options: [] },
          raw: raw("thread/status/changed", agent.unmatchedFlag.data),
        });
    } else if (method === "item/started" || method === "item/completed") {
      translateItem(agent, native, p, method, frame, now, translation, facts);
    } else if (
      isKnownDelta(method) ||
      method.endsWith("/delta") ||
      method.endsWith("/outputDelta")
    ) {
      translateDelta(agent, p, method, frame, translation, facts);
    } else if (method === "turn/plan/updated") {
      const todos = list(p["plan"]).map((entry) => {
        const step = obj(entry);
        return {
          content: str(step["step"]),
          status:
            step["status"] === "completed"
              ? ("completed" as const)
              : step["status"] === "inProgress" || step["status"] === "in_progress"
                ? ("in_progress" as const)
                : ("pending" as const),
        };
      });
      facts.push({
        type: "item.upsert",
        agent: agent.key,
        item: `codex:plan-update:${str(p["turnId"], agent.turn)}`,
        draft: {
          type: "tool_call",
          complete: true,
          call: {
            kind: "todo",
            title: str(p["explanation"], "Update plan"),
            status: "succeeded",
            detail: { kind: "todo", todos },
            raw: raw(method, frame.data),
          },
        },
      });
    } else if (method === "error") {
      const error = turnError(p["error"]);
      facts.push(note(agent.key, method, frame.data, error?.message));
      if (p["willRetry"] === true)
        facts.push({
          type: "retry",
          agent: agent.key,
          on: /rateLimit|serverOverloaded|usageLimit/.test(
            JSON.stringify(obj(p["error"])["codexErrorInfo"]),
          )
            ? "rate_limit"
            : "network",
          message: error?.message ?? "Codex retry",
        });
    } else if (method === "thread/status/changed") {
      const status = obj(p["status"]);
      const flags = list(status["activeFlags"]);
      if (status["type"] === "active" && !agent.turn)
        facts.push({ type: "wake.expected", agent: agent.key, until: now + 2_000 });
      if ((status["type"] === "idle" || status["type"] === "notLoaded") && !agent.turn)
        facts.push({ type: "wake.expected", agent: agent.key, until: now });
      const key = `status:${native}`;
      if (flags.length && agent.requests.size === 0) {
        agent.unmatchedFlag = { data: p, since: now };
        facts.push({
          type: "interaction.opened",
          agent: agent.key,
          interaction: key,
          blocking: true,
          request: { kind: "approval", title: "Codex is waiting for input", options: [] },
          raw: raw(method, p),
        });
      } else delete agent.unmatchedFlag;
      if (!flags.length || agent.requests.size > 0)
        facts.push({ type: "interaction.closed", interaction: key, state: "cancelled" });
      if (status["type"] === "systemError")
        facts.push({
          type: "turn.ended",
          agent: agent.key,
          ...(agent.turn ? { nativeTurnId: agent.turn } : {}),
          outcome: "failed",
          error: { kind: "provider", message: "Codex thread reported systemError" },
        });
    } else if (method === "thread/settings/updated")
      agent.mode = str(obj(p["collaborationMode"])["mode"], agent.mode);
    else if (method.startsWith("thread/goal/")) agent.pendingTrigger = "goal";
    else if (method === "thread/queue/changed") agent.pendingTrigger = "queue";
    else if (method === "thread/tokenUsage/updated") {
      const usage = obj(obj(p["tokenUsage"])["last"]);
      if (typeof usage["inputTokens"] === "number" && typeof usage["outputTokens"] === "number")
        facts.push({
          type: "usage",
          agent: agent.key,
          inputTokens: usage["inputTokens"],
          outputTokens: usage["outputTokens"],
          ...(typeof usage["cachedInputTokens"] === "number"
            ? { cachedInputTokens: usage["cachedInputTokens"] }
            : {}),
        });
    } else facts.push(note(agent.key, method || "unknown", frame.data));
    return facts;
  }
  return {
    translate(frame, now) {
      try {
        return handle(frame, now);
      } catch {
        return [note(init.rootKey, "malformed", frame.data)];
      }
    },
    tick(now) {
      const facts: Fact[] = [];
      for (const [native, agent] of agents)
        if (agent.unmatchedFlag && now >= agent.unmatchedFlag.since)
          facts.push({
            type: "interaction.opened",
            agent: agent.key,
            interaction: `status:${native}`,
            blocking: true,
            request: { kind: "approval", title: "Codex is waiting for input", options: [] },
            raw: raw("thread/status/changed", agent.unmatchedFlag.data),
          });
      return facts;
    },
  };
}
