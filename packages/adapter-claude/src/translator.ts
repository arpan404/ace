import { factRaw, canonicalOnly } from "./raw-facts.ts";
import { interactionFrame } from "./translate-interactions.ts";
import type { Key } from "@ace/core";
import type { Translator, Frame } from "@ace/engine-api";
import { rateLimitFacts } from "./rate-limits.ts";
import { ResultUsage } from "./result-usage.ts";
import { NativeQueue } from "./native-queue.ts";
import { PendingTranscripts } from "./pending-transcripts.ts";
import { MessageIndex } from "./blocks.ts";
import { ClaudeState } from "./state.ts";
import { message, stream, finishStream, type StreamState } from "./content.ts";
import { taskFrame, taskTick } from "./tasks.ts";
import { number, object, string, type Data } from "./native.ts";

export function createTranslator(init: { rootKey: Key }): Translator {
  let state = new ClaudeState(init.rootKey);
  let accounting = new ResultUsage();
  let queue = new NativeQueue();
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
      if (subtype === "compact_boundary") {
        state.emit({
          type: "item.upsert",
          agent: state.root,
          item: state.key("compact", String(frame.seq)),
          draft: { type: "compaction", complete: true },
        });
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
        state.retryOn =
          error === "rate_limit" || data["error_status"] === 429
            ? "rate_limit"
            : data["error_status"] == null
              ? "network"
              : "upstream";
        state.emit({
          type: "retry",
          agent: state.root,
          on: state.retryOn,
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
    if (type === "conversation_reset") {
      accounting.reset(data);
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
      for (const fact of accounting.facts(state, data)) state.emit(fact);
      return true;
    }
    if (type === "rate_limit_event") {
      rateLimitFacts(state, data);
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
  return {
    translate(frame, now) {
      state.facts = [];
      // Frames are JSON data. Lenient readers never decode through a strict SDK union.
      const data = object(frame.data);
      if (frame.channel === "lifecycle" && data["type"] === "process.started") {
        state = new ClaudeState(init.rootKey);
        accounting = new ResultUsage();
        queue = new NativeQueue();
        streams.clear();
        messages.clear();
        pending.clear();
      }
      taskTick(state, now);
      state.ensureRoot(data);
      state.emit({ type: "signal", agent: state.agentFor(data) });
      if (
        frame.channel === "sdk" &&
        frame.dir === "recv" &&
        data["type"] === "result" &&
        !accounting.accept(data)
      ) {
        state.notice(
          frame.data,
          `native:${frame.seq}`,
          state.root,
          "info",
          "Claude duplicate result",
        );
        return state.facts;
      }
      queue.observe(state, frame, data);
      if (pending.defer(state, frame)) return state.facts;
      if (interactionFrame(state, frame, data)) {
        // Interaction owner reports only lifecycle facts.
      } else if (frame.channel === "lifecycle" && data["type"] === "process.exited") {
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
