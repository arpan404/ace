import type { Fact, Key } from "@ace/core";
import type { Translator, Frame } from "./contract.ts";
import { ClaudeState } from "./state.ts";
import { message, stream, tool, type StreamState } from "./content.ts";
import { taskFrame, taskTick } from "./tasks.ts";
import { requestFor, resolutionFor } from "./interactions.ts";
import { number, object, string, type Data } from "./native.ts";

export function createTranslator(init: { rootKey: Key }): Translator {
  const state = new ClaudeState(init.rootKey);
  const streams = new Map<string, StreamState>();
  function sdk(data: Data, frame: Frame, now: number): boolean {
    const type = string(data["type"]);
    if (type === "system") {
      if (taskFrame(state, data, now)) return true;
      const subtype = string(data["subtype"]);
      if (subtype === "init") {
        state.start(state.root, state.sent ? "user" : (state.wake ?? "unknown"));
        state.sent = false;
        state.wake = undefined;
        state.wakeDuringTurn = false;
        return true;
      }
      if (subtype === "status" || subtype === "thinking_tokens") {
        state.emit({
          type: "activity",
          agent: state.root,
          activity: data["status"] === "compacting" ? "compacting" : "thinking",
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
        if (data["state"] !== "idle") state.expectWake(now);
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
      message(state, data, frame.seq);
      return true;
    }
    if (type === "result") {
      const aborted = string(data["terminal_reason"]).startsWith("aborted_");
      const failed = !aborted && data["is_error"] === true;
      if (state.wakeDuringTurn && object(data["origin"])["kind"] !== "task-notification")
        state.emit({ type: "wake.expected", agent: state.root, until: now + 5_000 });
      state.emit({
        type: "turn.ended",
        agent: state.root,
        outcome: aborted ? "interrupted" : failed ? "failed" : "completed",
        trigger:
          object(data["origin"])["kind"] === "task-notification"
            ? (state.wake ?? "background_completion")
            : "user",
        ...(failed
          ? {
              error: {
                kind: "provider" as const,
                message: string(data["result"], "Claude execution failed"),
              },
            }
          : {}),
      });
      state.active.delete(state.root);
      state.emit({ type: "queue.changed", count: Math.floor(number(data["queued_turn_count"])) });
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
      state.emit({
        type: "interaction.closed",
        interaction: state.key("interaction", id),
        state: "resolved",
        resolution: resolutionFor(interaction.request, data["result"]),
      });
      state.interactions.delete(id);
      return;
    }
    const options = object(data["options"]);
    const id = string(options["requestId"]);
    if (!id) return;
    const native = string(options["agentID"]);
    const agent = native
      ? (state.nativeAgents.get(native) ??
        state.child(`native:${native}`, state.root, false, native))
      : state.root;
    const toolId = string(options["toolUseID"], `interaction:${id}`);
    const name = string(data["toolName"], "Unknown tool");
    tool(state, agent, { id: toolId, name, input: data["input"] }, data, true);
    const request = requestFor(name, object(data["input"]), options);
    state.interactions.set(id, { agent, item: state.key("tool", toolId), request });
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
      state.ensureRoot(data);
      state.emit({ type: "signal", agent: state.agentFor(data) });
      if (frame.channel === "can_use_tool") permission(data, frame);
      else if (frame.channel === "lifecycle" && data["type"] === "process.exited") {
        state.emit({
          type: "process.exited",
          deliberate: data["deliberate"] === true,
          message: string(data["message"]),
        });
        state.level.clear();
        state.missing.clear();
      } else if (frame.channel !== "sdk" || !sdk(data, frame, now)) {
        state.notice(
          frame.data,
          `${frame.seq}`,
          state.root,
          frame.dir === "stderr" ? "warning" : "info",
          typeof frame.data === "string" ? frame.data : "Claude frame",
        );
      }
      return state.facts;
    },
    tick(now) {
      return [...taskTick(state, now), { type: "tick" }];
    },
  };
}
