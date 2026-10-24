import { systemNotice } from "./system-notices.ts";
import { claudeGoal } from "./goal.ts";
import { factRaw, canonicalOnly } from "./raw-facts.ts";
import { interactionFrame } from "./translate-interactions.ts";
import type { Key } from "@ace/core";
import type { Translator, Frame } from "@ace/engine-api";
import { rateLimitFacts, clearRateLimit, clearRetry } from "./rate-limits.ts";
import { ResultUsage } from "./result-usage.ts";
import { NativeQueue } from "./native-queue.ts";
import { ConsumedInputs } from "./consumed-inputs.ts";
import { SteerContinuation } from "./steer-continuation.ts";
import { PendingTranscripts } from "./pending-transcripts.ts";
import { MessageIndex } from "./blocks.ts";
import { ClaudeState } from "./state.ts";
import { message, stream, finishStream, type StreamState } from "./content.ts";
import { taskFrame, taskTick } from "./tasks.ts";
import { number, object, string, raw, type Data } from "./native.ts";
import { tokenCounts } from "./token-counts.ts";

/** Any token in or out of the model means the turn reached it. */
function modelAnswered(data: Data): boolean {
  const usage = tokenCounts(data["usage"]);
  return usage !== undefined && usage.inputTokens + usage.outputTokens > 0;
}

export function createTranslator(init: { rootKey: Key }): Translator {
  let state = new ClaudeState(init.rootKey);
  let accounting = new ResultUsage();
  let queue = new NativeQueue();
  let consumed = new ConsumedInputs();
  let steers = new SteerContinuation();
  const streams = new Map<string, StreamState>();
  const messages = new MessageIndex(init.rootKey);
  const pending = new PendingTranscripts();
  let diagnostics: import("@ace/protocol").RawPayload[] = [];
  function sdk(data: Data, frame: Frame, now: number): boolean {
    const type = string(data["type"]);
    if (type === "summary" && typeof data["summary"] === "string") {
      state.emit({
        type: "item.upsert",
        agent: state.root,
        item: "provider:title",
        draft: {
          type: "notice",
          code: "thread_title",
          title: data["summary"],
          text: data["summary"],
          level: "info",
          complete: true,
        },
      });
      return true;
    }
    if (type === "system") {
      if (taskFrame(state, data, now)) return true;
      const subtype = string(data["subtype"]);
      if (subtype === "init") {
        clearRateLimit(state);
        if (typeof data["model"] === "string" && data["model"]) {
          state.model = data["model"];
          state.emit({ type: "agent.linked", agent: state.root, model: state.model });
        }
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
        // Claude retrying a throttled request (429 included) is a wait, not a usage limit:
        // only a rejected `rate_limit_event` or a turn's `rate_limit` error is one.
        state.retryOn = data["error_status"] == null ? "network" : "upstream";
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
      const notice = systemNotice(data);
      if (notice) {
        state.notice(data, String(frame.seq), state.agentFor(data), notice.level, notice.text);
        return true;
      }
      return false;
    }
    if (type === "stream_event") {
      if (!data["parent_tool_use_id"] && object(data["event"])["type"] === "message_start") {
        clearRateLimit(state);
        clearRetry(state);
      }
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
    if (type === "active_goal") {
      const goal = claudeGoal(data);
      if (goal !== undefined) state.emit({ type: "goal.updated", agent: state.root, goal });
      return true;
    }
    if (type === "conversation_reset") {
      accounting.reset(data);
      return true;
    }
    if (type === "result") {
      finishStream(state, streams, state.root);
      const aborted = string(data["terminal_reason"]).startsWith("aborted_");
      if (steers.carriesOn(aborted)) {
        // Claude cut its request short to take a steer: the turn goes on with it.
        messages.endRoot();
        state.releaseTurn();
        for (const fact of accounting.facts(state, data)) state.emit(fact);
        return true;
      }
      const lastError = state.errors.get(state.root);
      const notified = object(data["origin"])["kind"] === "task-notification";
      // Claude can close a queued notification without asking the model, folding it into a
      // later turn. Such a turn did no work: it keeps the earlier outcome and the wake goes on.
      const folded =
        notified &&
        !aborted &&
        data["is_error"] !== true &&
        lastError === undefined &&
        !state.contentSeen.has(state.root) &&
        !modelAnswered(data);
      const error = lastError ?? (folded ? state.rootFailure : undefined);
      const failed = !aborted && (data["is_error"] === true || error !== undefined);
      if (!failed && !aborted) clearRateLimit(state);
      if ((state.wakeDuringTurn && !notified) || folded) {
        state.wake ??=
          state.runTrigger === "subagent_result" ? "subagent_result" : "background_completion";
        state.wakeUntil = now + 5_000;
        state.emit({ type: "wake.expected", agent: state.root, until: state.wakeUntil });
      }
      const ended = failed
        ? {
            ...error,
            kind: error?.kind ?? ("provider" as const),
            message: error?.message ?? string(data["result"], "Claude execution failed"),
            ...(error?.details ? { details: error.details } : {}),
          }
        : undefined;
      state.emit({
        type: "turn.ended",
        agent: state.root,
        outcome: aborted ? "interrupted" : failed ? "failed" : "completed",
        trigger: notified
          ? state.runTrigger === "subagent_result"
            ? "subagent_result"
            : "background_completion"
          : state.runTrigger === "unknown"
            ? "user"
            : state.runTrigger,
        ...(ended ? { error: ended } : {}),
      });
      if (ended || !folded) state.rootFailure = ended;
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
    return type === "keep_alive" || type === "control_response";
  }
  return {
    takeDiagnostics() {
      const result = [...diagnostics, ...state.diagnostics];
      diagnostics = [];
      state.diagnostics = [];
      return result;
    },
    translate(frame, now) {
      diagnostics = [];
      state.facts = [];
      state.diagnostics = [];
      // Frames are JSON data. Lenient readers never decode through a strict SDK union.
      const data = object(frame.data);
      if (frame.channel === "lifecycle" && data["type"] === "process.started") {
        // Placeholders of the replaced process keep its keys; nothing of it is live anymore.
        pending.close(state);
        const ended = state.facts;
        state = new ClaudeState(init.rootKey);
        state.facts = ended;
        accounting = new ResultUsage();
        queue = new NativeQueue();
        consumed = new ConsumedInputs();
        steers = new SteerContinuation();
        streams.clear();
        messages.clear();
      }
      taskTick(state, now);
      pending.expire(state, now);
      state.ensureRoot(data);
      state.emit({ type: "signal", agent: state.agentFor(data) });
      if (
        frame.channel === "sdk" &&
        frame.dir === "recv" &&
        data["type"] === "result" &&
        !accounting.accept(data)
      ) {
        diagnostics.push(raw(frame.data));
        return state.facts;
      }
      queue.observe(state, frame, data);
      steers.observe(state, frame, data);
      if (pending.defer(state, frame, now)) return state.facts;
      if (frame.channel === "sdk") pending.observe(state, data);
      if (interactionFrame(state, frame, data)) {
        // Interaction owner reports only lifecycle facts.
      } else if (frame.channel === "lifecycle" && data["type"] === "process.exited") {
        state.emit({
          type: "process.exited",
          deliberate: data["deliberate"] === true,
          message: string(data["message"]),
        });
        // After the exit fact, so work the exit cost still counts; then nothing of it is live.
        pending.close(state);
        state.level.clear();
        state.missing.clear();
      } else if (frame.channel === "lifecycle" && data["type"] === "process.started") {
        // ensureRoot already emitted the startup fact.
      } else if (frame.channel !== "sdk" || !sdk(data, frame, now)) {
        state.notice(
          frame.data,
          `${frame.seq}`,
          state.root,
          frame.dir === "stderr" ? "warning" : "info",
          undefined,
        );
      }
      consumed.observe(state, frame, data);
      pending.bindRegistered(state);
      const bindings = state.bindings;
      state.bindings = [];
      for (const spawn of bindings)
        for (const deferred of pending.take(state, spawn)) {
          const start = state.facts.length;
          const diagnosticStart = state.diagnostics.length;
          if (!pending.defer(state, deferred, now)) {
            const replayed = object(deferred.data);
            pending.observe(state, replayed);
            sdk(replayed, deferred, now);
          }
          // Receipt already retained this payload; replay only enriches canonical facts.
          state.diagnostics.length = diagnosticStart;
          for (let index = start; index < state.facts.length; index++) {
            const fact = state.facts[index];
            if (fact) state.facts[index] = canonicalOnly(fact);
          }
        }
      for (const fact of state.facts)
        if (fact.type === "turn.ended" && fact.agent !== state.root)
          finishStream(state, streams, fact.agent);
        else if (fact.type === "turn.ended") pending.turnEnded(now);
      const carriesRaw = state.facts.some((fact) =>
        factRaw(fact).some(
          (payload) => "data" in payload && (payload.data === frame.data || payload.data === data),
        ),
      );
      const diagnosed = state.diagnostics.some(
        (payload) => "data" in payload && (payload.data === frame.data || payload.data === data),
      );
      if (!carriesRaw && !diagnosed && frame.channel !== "lifecycle")
        diagnostics.push(raw(frame.data));
      return state.facts;
    },
    nextDeadline() {
      const deadlines = [
        state.missing.nextDeadline(),
        state.wakeUntil,
        pending.nextDeadline(),
      ].filter((at) => at !== undefined);
      return deadlines.length ? Math.min(...deadlines) : undefined;
    },
    tick(now) {
      state.facts = [];
      if (state.wakeUntil !== undefined && now >= state.wakeUntil) {
        state.wake = undefined;
        state.wakeUntil = undefined;
      }
      pending.expire(state, now);
      return [...taskTick(state, now), { type: "tick" }];
    },
  };
}
