import type { Fact, Key } from "@ace/core";
import type { RawPayload } from "@ace/protocol";
import type { Translator, Frame } from "@ace/engine-api";
import { PendingTranscripts } from "./pending-transcripts.ts";
import { MessageIndex } from "./blocks.ts";
import { ClaudeState } from "./state.ts";
import { message, stream, tool, finishStream, type StreamState } from "./content.ts";
import { taskFrame, taskTick } from "./tasks.ts";
import { requestFor, resolutionFor } from "./interactions.ts";
import { number, object, string, type Data } from "./native.ts";

function factRaw(fact: Fact): RawPayload[] {
  if (fact.type === "item.upsert") {
    if (fact.draft.type === "tool_call") return fact.draft.call?.raw ?? [];
    if (fact.draft.type !== "compaction") return fact.draft.raw ?? [];
  }
  if (fact.type === "interaction.opened" || fact.type === "background.started")
    return fact.raw ?? [];
  return [];
}

// Deferred frames already persist their raw payload at receipt, before identity is known.
function canonicalOnly(fact: Fact): Fact {
  if (fact.type === "item.upsert") {
    if (fact.draft.type === "tool_call")
      return { ...fact, draft: { ...fact.draft, call: { ...fact.draft.call, raw: [] } } };
    if (fact.draft.type !== "compaction") return { ...fact, draft: { ...fact.draft, raw: [] } };
  }
  if (fact.type === "interaction.opened" || fact.type === "background.started")
    return { ...fact, raw: [] };
  return fact;
}

export function createTranslator(init: { rootKey: Key }): Translator {
  let state = new ClaudeState(init.rootKey);
  const streams = new Map<string, StreamState>();
  const messages = new MessageIndex(init.rootKey);
  const pending = new PendingTranscripts();
  function sdk(data: Data, frame: Frame, now: number): boolean {
    const type = string(data["type"]);
    if (type === "system") {
      if (taskFrame(state, data, now)) return true;
      const subtype = string(data["subtype"]);
      if (subtype === "init") {
        state.start(state.root, state.sent ? "user" : (state.wake ?? "unknown"));
        state.errors.delete(state.root);
        state.sent = false;
        state.wake = undefined;
        state.wakeDuringTurn = false;
        return true;
      }
      if (subtype === "status" || subtype === "thinking_tokens") {
        state.emit({
          type: "activity",
          agent: state.root,
          activity:
            data["status"] === "compacting"
              ? "compacting"
              : subtype === "thinking_tokens" || state.contentSeen.has(state.root)
                ? "thinking"
                : "starting_turn",
        });
        return true;
      }
      if (subtype === "api_retry") {
        const error = string(data["error"]);
        state.emit({
          type: "retry",
          agent: state.root,
          on:
            error === "rate_limit" || data["error_status"] === 429
              ? "rate_limit"
              : data["error_status"] == null
                ? "network"
                : "upstream",
          message: error,
          ...(number(data["attempt"]) > 0 ? { attempt: Math.floor(number(data["attempt"])) } : {}),
        });
        return true;
      }
      if (subtype === "session_state_changed") {
        state.sessionState = string(data["state"]);
        if (state.sessionState === "idle") state.emit({ type: "retry.cleared", agent: state.root });
        else if (!state.active.has(state.root))
          state.emit({
            type: "retry",
            agent: state.root,
            on: "upstream",
            message: "Claude session has not settled",
          });
        return true;
      }
      return false;
    }
    if (type === "stream_event") {
      stream(state, data, streams);
      return true;
    }
    if (type === "assistant" || type === "user") {
      if (frame.dir === "send" && type === "user") {
        state.sent = true;
        state.start(state.root, "user");
      }
      message(state, data, frame.seq, streams, messages);
      return true;
    }
    if (type === "result") {
      finishStream(state, streams, state.root);
      const aborted = string(data["terminal_reason"]).startsWith("aborted_");
      const lastError = state.errors.get(state.root);
      const failed = !aborted && (data["is_error"] === true || lastError !== undefined);
      if (state.wakeDuringTurn && object(data["origin"])["kind"] !== "task-notification") {
        state.wakeUntil = now + 5_000;
        state.emit({ type: "wake.expected", agent: state.root, until: state.wakeUntil });
      }
      state.emit({
        type: "turn.ended",
        agent: state.root,
        outcome: aborted ? "interrupted" : failed ? "failed" : "completed",
        trigger:
          object(data["origin"])["kind"] === "task-notification"
            ? state.runTrigger === "subagent_result"
              ? "subagent_result"
              : "background_completion"
            : state.runTrigger === "unknown"
              ? "user"
              : state.runTrigger,
        ...(failed
          ? {
              error: {
                kind: lastError?.kind ?? ("provider" as const),
                message: lastError?.message ?? string(data["result"], "Claude execution failed"),
              },
            }
          : {}),
      });
      state.active.delete(state.root);
      messages.endRoot();
      state.releaseTurn();
      if (state.sessionState && state.sessionState !== "idle")
        state.emit({
          type: "retry",
          agent: state.root,
          on: "upstream",
          message: "Claude session has not settled",
        });
      const queued = Math.floor(number(data["queued_turn_count"]));
      if (queued !== state.nativeQueued) {
        state.emit({ type: "queue.changed", count: queued, source: "provider" });
        state.nativeQueued = queued;
      }
      const usage = object(data["usage"]);
      state.emit({
        type: "usage",
        agent: state.root,
        inputTokens: number(usage["input_tokens"]),
        outputTokens: number(usage["output_tokens"]),
        cachedInputTokens: number(usage["cache_read_input_tokens"]),
        costUsd: number(data["total_cost_usd"]),
      });
      return true;
    }
    if (type === "rate_limit_event") {
      const info = object(data["rate_limit_info"]);
      if (info["status"] === "rejected")
        state.emit({
          type: "retry",
          agent: state.root,
          on: "rate_limit",
          message: "Claude rate limit",
        });
      else state.emit({ type: "retry.cleared", agent: state.root });
      return true;
    }
    if (type === "control_cancel_request") {
      const id = string(data["request_id"]);
      if (state.interactions.delete(id))
        state.emit({
          type: "interaction.closed",
          interaction: state.key("interaction", id),
          state: "cancelled",
        });
      return true;
    }
    return type === "keep_alive";
  }
  function permission(data: Data, frame: Frame): void {
    if (frame.dir === "send") {
      const id = string(data["requestId"]);
      const interaction = state.interactions.get(id);
      if (!interaction) return;
      state.toolFrames.set(interaction.toolId, frame.seq);
      const result = object(data["result"]);
      const denied = result["behavior"] === "deny";
      // A late reply cannot replace a tool's settled outcome or reopen its work.
      if (!state.terminalChildren.has(interaction.agent))
        state.emit({
          type: "item.upsert",
          agent: interaction.agent,
          item: interaction.item,
          draft: {
            type: "tool_call",
            complete: denied,
            call: {
              status: denied
                ? result["interrupt"] === true
                  ? "cancelled"
                  : "declined"
                : "running",
            },
          },
        });
      state.emit({
        type: "interaction.closed",
        interaction: state.key("interaction", id),
        state: "resolved",
        resolution: resolutionFor(interaction.request, data["result"], data["resolution"]),
      });
      state.interactions.delete(id);
      return;
    }
    const options = object(data["options"]);
    const id = string(options["requestId"]);
    if (!id) return;
    const native = string(options["agentID"]);
    const task = state.tasks.get(native);
    const agent = native
      ? (state.nativeAgents.get(native) ??
        state.child(`native:${native}`, state.root, false, native, task?.terminalStatus))
      : state.root;
    if (task?.terminal) {
      task.child = agent;
      state.endChild(task, task.terminalStatus ?? "failed");
    }
    const toolId = string(options["toolUseID"], `interaction:${id}`);
    const name = string(data["toolName"], "Unknown tool");
    state.toolFrames.set(toolId, frame.seq);
    tool(state, agent, { id: toolId, name, input: data["input"] }, data, true);
    const request = requestFor(name, object(data["input"]), options);
    state.interactions.set(id, { agent, item: state.key("tool", toolId), toolId, request });
    state.emit({
      type: "interaction.opened",
      agent,
      interaction: state.key("interaction", id),
      item: state.key("tool", toolId),
      blocking: true,
      request,
      raw: [{ type: "can_use_tool", name, data }],
    });
  }
  return {
    translate(frame, now) {
      state.facts = [];
      // Frames are JSON data. Lenient readers never decode through a strict SDK union.
      const data = object(frame.data);
      if (frame.channel === "lifecycle" && data["type"] === "process.started") {
        state = new ClaudeState(init.rootKey);
        streams.clear();
        messages.clear();
        pending.clear();
      }
      taskTick(state, now);
      state.ensureRoot(data);
      state.emit({ type: "signal", agent: state.agentFor(data) });
      if (pending.defer(state, frame)) return state.facts;
      if (frame.channel === "can_use_tool") permission(data, frame);
      else if (frame.channel === "lifecycle" && data["type"] === "process.exited") {
        state.emit({
          type: "process.exited",
          deliberate: data["deliberate"] === true,
          message: string(data["message"]),
        });
        state.level.clear();
        state.missing.clear();
        pending.clear();
      } else if (frame.channel === "lifecycle" && data["type"] === "process.started") {
        // ensureRoot already emitted the startup fact.
      } else if (frame.channel !== "sdk" || !sdk(data, frame, now)) {
        state.notice(
          frame.data,
          `${frame.seq}`,
          state.root,
          frame.dir === "stderr" ? "warning" : "info",
          typeof frame.data === "string" ? frame.data : "Claude frame",
        );
      }
      const bindings = state.bindings;
      state.bindings = [];
      for (const spawn of bindings)
        for (const deferred of pending.take(state, spawn)) {
          const start = state.facts.length;
          sdk(object(deferred.data), deferred, now);
          for (let index = start; index < state.facts.length; index++) {
            const fact = state.facts[index];
            if (fact) state.facts[index] = canonicalOnly(fact);
          }
        }
      for (const fact of state.facts)
        if (fact.type === "turn.ended" && fact.agent !== state.root)
          finishStream(state, streams, fact.agent);
      const carriesRaw = state.facts.some((fact) => {
        const payloads = factRaw(fact);
        return payloads.some(
          (payload) => "data" in payload && (payload.data === frame.data || payload.data === data),
        );
      });
      if (!carriesRaw && frame.channel !== "lifecycle")
        state.notice(
          frame.data,
          `native:${frame.seq}`,
          state.agentFor(data),
          "info",
          "Claude event",
        );
      return state.facts;
    },
    nextDeadline() {
      const missing = state.missing.nextDeadline();
      return missing === undefined
        ? state.wakeUntil
        : Math.min(missing, state.wakeUntil ?? Infinity);
    },
    tick(now) {
      state.facts = [];
      if (state.wakeUntil !== undefined && now >= state.wakeUntil) {
        state.wake = undefined;
        state.wakeUntil = undefined;
      }
      return [...taskTick(state, now), { type: "tick" }];
    },
  };
}
