import { CodexExitDiagnostic } from "./exit-diagnostic.ts";
import { answerEchoes } from "./answer-echo.ts";
import { confirmModel } from "./model.ts";
import { unknownBuffers, RecentSet } from "./retention.ts";
import type { Fact, Key } from "@ace/core";
import type { ThreadId, RunTrigger } from "@ace/protocol";
import type { Frame, Translator } from "@ace/engine-api";
import type { Agent, TranslationContext } from "./translator-state.ts";
import { createAgentRegistry } from "./agent-registry.ts";
import { completeTurn } from "./translate-turn.ts";
import { translateItem } from "./translate-item.ts";
import { isKnownDelta, translateDelta } from "./translate-delta.ts";
import { isInteractiveRequest, openRequest, turnError } from "./interactions.ts";
import { list, obj, raw, requestKey, str, type Obj } from "./native.ts";

export function createCodexTranslator(init: { threadId: ThreadId; rootKey: Key }): Translator {
  const agents = new Map<string, Agent>();
  const sent = new Map<string, { method: string; params: Obj; interaction?: string }>();
  let recordedAnswer: string | undefined;
  const userTurns = new RecentSet();
  const buffers = unknownBuffers();
  const asyncOwners: TranslationContext["asyncOwners"] = new Map();
  let unknownGuard = false;
  function finishUnknown(facts: Fact[]) {
    if (unknownGuard && buffers.pending === 0 && !buffers.overflow) {
      facts.push({ type: "background.ended", task: "codex:unknown-threads", status: "completed" });
      unknownGuard = false;
    }
  }
  function closeAsync(key: string) {
    // Retain native identity after resolution so duplicate live notifications stay terminal.
    asyncOwners.delete(key);
  }

  let scope = "";
  const interactionKey = (id: unknown) => requestKey(id, scope);
  let root = "";
  let cwd = "";
  const { ensure, discover } = createAgentRegistry({
    agents,
    rootKey: init.rootKey,
    getRoot: () => root,
    getCwd: () => cwd,
    replay: handle,
    takeBuffer: buffers.take,
    discovered: finishUnknown,
  });
  const translation: TranslationContext = {
    answerEchoes: answerEchoes(),
    agents,
    tasks: new Set(),
    asyncOwners,
    discover,
    note: (...args) => note(...args),
  };
  let diagnostics: import("@ace/protocol").RawPayload[] = [];
  let diagnosticFrame: unknown;
  let synthetic = 0;
  let deliberate = false;
  const note = (agent: Key, type: string, data: unknown, text?: string): Fact => {
    if (text === undefined) {
      if (data !== diagnosticFrame) diagnostics.push(...raw(type, data));
      return { type: "signal", agent };
    }
    return {
      type: "item.upsert",
      agent,
      item: `codex:raw:${++synthetic}`,
      draft: { type: "notice", level: "info", text, complete: true, raw: raw(type, data) },
    };
  };
  function title(value: unknown, data: unknown): Fact[] {
    const text = str(value).trim();
    return text
      ? [
          {
            type: "item.upsert",
            agent: init.rootKey,
            item: "codex:thread-title",
            draft: {
              type: "notice",
              code: "thread_title",
              title: text,
              level: "info",
              text,
              complete: true,
              raw: raw("thread/name/updated", data),
            },
          },
        ]
      : [];
  }
  function handle(frame: Frame, now: number): Fact[] {
    const facts: Fact[] = [];
    const message = obj(frame.data),
      p = obj(message["params"]),
      method = str(message["method"]);
    const id = message["id"];
    if (frame.dir === "note") {
      translation.answerEchoes.note(message);
      if (message["event"] === "session-scope") scope = str(message["scope"]);
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
        if (asyncOwners.size === 1) recordedAnswer = asyncOwners.keys().next().value;
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
      if (message["event"] === "discovery-finished") {
        buffers.clear();
        finishUnknown(facts);
        facts.push({
          type: "background.ended",
          task: str(message["task"], "codex:discovery"),
          status: "completed",
        });
      }
      if (message["event"] === "queue-state" && typeof message["count"] === "number")
        facts.push({ type: "queue.changed", count: message["count"] });
      if (message["event"] === "stop") deliberate = true;
      if (message["event"] === "process-exit")
        facts.push({ type: "process.exited", deliberate, message: "Codex app-server exited" });
      if (message["event"] === "interaction-resolved") {
        closeAsync(str(message["interaction"]));
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
      return facts;
    }
    if (frame.dir === "stderr") {
      return [note(init.rootKey, "stderr", frame.data)];
    }
    if (!method && id !== undefined) {
      const pending = sent.get(requestKey(id));
      sent.delete(requestKey(id));
      const result = obj(message["result"]);
      const thread = obj(result["thread"]);
      if (pending?.method === "initialize" && message["error"] === undefined)
        facts.push({ type: "process.started" });
      if (
        pending?.method === "thread/start" ||
        pending?.method === "thread/resume" ||
        pending?.method === "thread/fork"
      ) {
        if (str(thread["id"])) {
          root = str(thread["id"]);
          cwd = str(thread["cwd"], str(pending.params["cwd"], cwd));
          const agent = discover(root, thread, facts, now);
          facts.push(...title(thread["name"], frame.data));
          confirmModel(agent, result["model"], facts);
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
        closeAsync(pending.interaction);
      }
      return facts;
    }
    if (method === "thread/started") {
      const thread = obj(p["thread"]);
      const native = str(thread["id"]);
      if (!native) return root ? [note(init.rootKey, method, frame.data)] : [];
      if (!root) root = native;
      discover(native, thread, facts, now, str(thread["parentThreadId"]) || undefined);
      if (native === root) facts.push(...title(thread["name"], frame.data));
      return facts;
    }
    const native = str(p["threadId"], root);
    if (!native) {
      return [note(init.rootKey, method || "unknown", frame.data)];
    }
    if (method === "thread/name/updated") {
      // Codex broadcasts names for unloaded threads too. A title is not evidence of a child.
      if (native === root) facts.push(...title(p["threadName"], frame.data));
      return facts;
    }
    if (native !== root && !agents.get(native)?.known) {
      facts.push(note(init.rootKey, method || "unknown", frame.data));
      buffers.push(native, frame);
      if (!unknownGuard) {
        unknownGuard = true;
        facts.push({
          type: "background.started",
          agent: init.rootKey,
          task: "codex:unknown-threads",
          kind: "other",
          title: "Discovering unknown Codex threads",
          stoppable: false,
        });
      }
      return facts;
    }
    const agent = ensure(native, true, facts);
    facts.push({ type: "signal", agent: agent.key });
    if (isInteractiveRequest(method) && id !== undefined) {
      const key = interactionKey(id);
      const item = str(p["itemId"]);
      const opened = openRequest(
        agent.key,
        key,
        method,
        p,
        agent.items.has(item),
        agent.open.get(item)?.data,
      );
      facts.push(...opened);
      if (item) agent.items.add(item);
      agent.requests.set(key, { item, turn: str(p["turnId"], agent.turn) });
      delete agent.unmatchedFlag;
      facts.push({
        type: "interaction.closed",
        interaction: `status:${native}`,
        state: "cancelled",
      });
    } else if (method === "serverRequest/resolved") {
      const key = interactionKey(p["requestId"]);
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
      completeTurn(agent, native, p, translation, facts, frame.channel !== "hydration");
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
      if (p["willRetry"] === true || error.kind === "quota")
        facts.push({
          type: "retry",
          agent: agent.key,
          on:
            error.kind === "quota"
              ? "rate_limit"
              : error.kind === "network"
                ? "network"
                : "upstream",
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
    } else if (method === "thread/settings/updated") {
      agent.mode = str(obj(p["collaborationMode"])["mode"], agent.mode);
      confirmModel(agent, p["model"], facts);
    } else if (method.startsWith("thread/goal/")) agent.pendingTrigger = "goal";
    else if (method === "thread/queue/changed") agent.pendingTrigger = "queue";
    else if (method === "thread/tokenUsage/updated") {
      const tokenUsage = obj(p["tokenUsage"]);
      const usage = obj(tokenUsage["last"]);
      if (
        Number.isSafeInteger(usage["totalTokens"]) &&
        typeof usage["totalTokens"] === "number" &&
        usage["totalTokens"] >= 0
      )
        facts.push({
          type: "context.sample",
          agent: agent.key,
          usedTokens: usage["totalTokens"],
          ...(typeof tokenUsage["modelContextWindow"] === "number" &&
          Number.isSafeInteger(tokenUsage["modelContextWindow"]) &&
          tokenUsage["modelContextWindow"] > 0
            ? { windowTokens: tokenUsage["modelContextWindow"] }
            : {}),
          sessionId: native,
          ...(agent.model ? { model: agent.model } : {}),
        });
      if (typeof usage["inputTokens"] === "number" && typeof usage["outputTokens"] === "number")
        facts.push({
          type: "usage",
          agent: agent.key,
          ...(agent.model ? { model: agent.model } : {}),
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
    takeDiagnostics() {
      const result = diagnostics;
      diagnostics = [];
      diagnosticFrame = undefined;
      return result;
    },
    translate(frame, now) {
      diagnosticFrame = frame.data;
      diagnostics = raw(
        frame.dir === "stderr"
          ? "stderr"
          : frame.dir === "note" && CodexExitDiagnostic.safeParse(frame.data).success
            ? "codex.session-exit"
            : str(obj(frame.data)["method"], "codex.frame"),
        frame.data,
      );
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
