import { factRaw, type Fact, type Key } from "@ace/core";
import type { Translator, Frame } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import { Dialog, Envelope, obj, str, list, isBlockingDialogMethod } from "./native.ts";
import { dialogRequest } from "./dialogs.ts";
import { toolDetail, resultSuffix } from "./tools.ts";
import { piTurnBoundary } from "./turn-boundary.ts";
import { piContextSample } from "./context-usage.ts";
import { messageFacts } from "./messages.ts";

const raw = (data: unknown) => [{ type: str(obj(data).type) || "unknown", data }];
export function createPiTranslator(init: { threadId: ThreadId; rootKey: Key }): Translator {
  const agent = init.rootKey;
  let diagnostics: import("@ace/protocol").RawPayload[] = [];
  let run = 0,
    active = false,
    message = 0,
    outcome: "completed" | "failed" | "interrupted" = "completed";
  let lastAnswer: Key | undefined;
  let poisoned = false;
  let settled = false;
  let prefix = "pi",
    deadline: number | undefined;
  const refreshDeadline = () => {
    deadline = undefined;
    for (const value of dialogs.values())
      if (value !== undefined && (deadline === undefined || value < deadline)) deadline = value;
  };
  const tools = new Map<string, { name: string; length: number; surviving: boolean }>();
  const dialogs = new Map<string, number | undefined>();
  const streamed = new Set<number>();

  const notice = (
    frame: Frame,
    text: string,
    level: "info" | "warning" | "error" = "info",
  ): Fact => ({
    type: "item.upsert",
    agent,
    item: `${prefix}:notice:${frame.seq}`,
    draft: { type: "notice", complete: true, text, level, raw: raw(frame.data) },
  });
  const start = (): Fact[] => {
    settled = false;
    if (active) return [];
    active = true;
    outcome = "completed";
    return [
      { type: "turn.started", agent, nativeTurnId: `${prefix}:run:${++run}`, trigger: "unknown" },
    ];
  };
  function overflow(frame: Frame): Fact[] {
    poisoned = true;
    return [
      notice(frame, "Pi live state cannot be represented; completion is uncertain", "error"),
      { type: "agent.disconnected", agent },
    ];
  }
  function finish(): Fact[] {
    if (!active || !settled || poisoned || dialogs.size) return [];
    active = false;
    return [
      { type: "retry.cleared", agent },
      { type: "turn.ended", agent, nativeTurnId: `${prefix}:run:${run}`, outcome },
    ];
  }
  return {
    takeDiagnostics() {
      const pending = diagnostics;
      diagnostics = [];
      return pending;
    },
    nextDeadline() {
      return deadline;
    },
    tick(now) {
      const facts: Fact[] = [];
      for (const [id, due] of dialogs)
        if (due !== undefined && now >= due) {
          dialogs.delete(id);
          facts.push({ type: "interaction.closed", interaction: id, state: "expired" });
        }
      refreshDeadline();
      facts.push(...finish());
      return facts;
    },
    translate(frame, now) {
      diagnostics = [];
      const facts = translate(frame, now);
      if (
        !facts.some((fact) =>
          factRaw(fact).some((payload) => "data" in payload && payload.data === frame.data),
        )
      )
        diagnostics = raw(frame.data);
      return facts;
    },
  };
  function translate(frame: Frame, now: number): Fact[] {
    const decoded = Envelope.safeParse(frame.data);
    if (!decoded.success)
      return frame.dir === "stderr" ? [notice(frame, str(frame.data), "warning")] : [];
    const e = decoded.data;
    if (frame.dir === "note") {
      if (e.type === "started") {
        prefix = str(e.processId) ? `pi:${str(e.processId)}` : "pi";
        return [{ type: "process.started" }];
      }
      if (e.type === "exited") {
        tools.clear();
        dialogs.clear();
        deadline = undefined;
        active = false;
        settled = false;
        return [
          { type: "process.exited", deliberate: e.deliberate === true, message: str(e.message) },
        ];
      }
      if (e.type === "dialog_expired") {
        const id = str(e.id);
        if (!dialogs.delete(id)) return [];
        refreshDeadline();
        return [{ type: "interaction.closed", interaction: id, state: "expired" }, ...finish()];
      }
    }
    if (frame.dir === "send") {
      if (e.type === "extension_ui_response") {
        const id = str(e.id);
        if (!dialogs.delete(id)) return [];
        refreshDeadline();
        return [
          {
            type: "interaction.closed",
            interaction: id,
            state: e.cancelled === true ? "cancelled" : "resolved",
          },
          ...finish(),
        ];
      }
      return [];
    }
    if (frame.dir !== "recv") return [];
    switch (e.type) {
      case "agent_start":
        return start();
      case "agent_end":
        return [];
      case "agent_settled": {
        if (!active || poisoned) return [];
        settled = true;
        const facts: Fact[] = [];
        for (const [id, tool] of tools)
          if (!tool.surviving) {
            tool.surviving = true;
            facts.push({
              type: "background.started",
              agent,
              task: `${prefix}:tool:${id}`,
              item: `${prefix}:tool:${id}`,
              kind: tool.name === "bash" ? "shell" : "other",
              title: `Pi ${tool.name} has no terminal result`,
              stoppable: false,
            });
          }
        facts.push(...finish());
        return facts;
      }
      case "message_start": {
        message++;
        streamed.clear();
        return [];
      }
      case "message_update": {
        const delta = obj(e.assistantMessageEvent),
          index = typeof delta.contentIndex === "number" ? delta.contentIndex : 0;
        const kind = str(delta.type);
        if (kind !== "text_delta" && kind !== "thinking_delta") return [];
        if (!streamed.has(index) && streamed.size >= 256) return overflow(frame);
        streamed.add(index);
        return [
          ...start(),
          {
            type: "item.delta",
            agent,
            item: `${prefix}:message:${message}:${index}`,
            field: kind === "text_delta" ? "text" : "reasoning",
            append: str(delta.delta),
          },
        ];
      }
      case "message_end": {
        const translated = messageFacts({ agent, prefix, message, streamed, data: frame.data });
        if (!translated) return overflow(frame);
        for (const fact of translated.facts)
          if (
            fact.type === "item.upsert" &&
            fact.draft.type === "message" &&
            fact.draft.role === "assistant"
          )
            lastAnswer = fact.item;
        if (translated.outcome) outcome = translated.outcome;
        return translated.facts;
      }
      case "tool_execution_start": {
        const id = str(e.toolCallId),
          name = str(e.toolName);
        if (!id) return [notice(frame, "Pi tool omitted identity", "warning")];
        if (!tools.has(id) && tools.size >= 256) return overflow(frame);
        tools.set(id, { name, length: 0, surviving: false });
        const detail = toolDetail(name, e.args);
        return [
          ...start(),
          {
            type: "item.upsert",
            agent,
            item: `${prefix}:tool:${id}`,
            draft: {
              type: "tool_call",
              complete: false,
              call: {
                kind: detail.kind,
                title: name,
                status: "running",
                detail,
                startedAt: now,
                raw: raw(frame.data),
              },
            },
          },
        ];
      }
      case "tool_execution_update":
      case "tool_execution_end": {
        const id = str(e.toolCallId),
          tool = tools.get(id),
          facts: Fact[] = [];
        if (!tool) return [notice(frame, "Pi tool result has no known start", "warning")];
        const suffix =
          tool.name === "bash"
            ? resultSuffix(
                e.type === "tool_execution_end" ? e.result : e.partialResult,
                tool.length,
              )
            : undefined;
        if (suffix && suffix.length > tool.length) {
          facts.push({
            type: "item.delta",
            agent,
            item: `${prefix}:tool:${id}`,
            field: "output",
            append: suffix.append,
          });
          tool.length = suffix.length;
        }
        if (e.type === "tool_execution_end") {
          facts.push({
            type: "item.upsert",
            agent,
            item: `${prefix}:tool:${id}`,
            draft: {
              type: "tool_call",
              complete: true,
              call: {
                status: e.isError === true ? "failed" : "succeeded",
                endedAt: now,
                raw: raw(frame.data),
              },
            },
          });
          if (tool.surviving)
            facts.push({
              type: "background.ended",
              task: `${prefix}:tool:${id}`,
              status: e.isError === true ? "failed" : "completed",
            });
          tools.delete(id);
        }
        return facts;
      }
      case "extension_ui_request": {
        const entryId = e.method === "notify" ? piTurnBoundary(e.message) : undefined;
        if (entryId && lastAnswer)
          return [
            {
              type: "item.upsert",
              agent,
              item: lastAnswer,
              draft: { type: "message", nativeId: entryId },
            },
          ];
        const sample = e.method === "notify" ? piContextSample(e.message) : undefined;
        if (sample) {
          return [
            {
              type: "context.sample",
              agent,
              usedTokens: sample.tokens,
              windowTokens: sample.contextWindow,
              ...(sample.model ? { model: sample.model } : {}),
            },
          ];
        }
        const p = Dialog.safeParse(e);
        if (!p.success && isBlockingDialogMethod(e.method)) return overflow(frame);
        if (!p.success) {
          if (e.method !== "notify") return [];
          return [
            notice(
              frame,
              str(e.message) || "Pi extension notification",
              e.notifyType === "error" ? "error" : e.notifyType === "warning" ? "warning" : "info",
            ),
          ];
        }
        const d = p.data;
        if (dialogs.has(d.id)) return [];
        if (dialogs.size >= 128) return overflow(frame);
        const due = d.timeout === undefined ? undefined : now + d.timeout;
        dialogs.set(d.id, due);
        if (due !== undefined && (deadline === undefined || due < deadline)) deadline = due;
        return [
          {
            type: "interaction.opened",
            agent,
            interaction: d.id,
            blocking: true,
            request: dialogRequest(d),
            raw: raw(frame.data),
          },
        ];
      }
      case "queue_update":
        return [
          {
            type: "queue.changed",
            source: "provider",
            count: list(e.steering).length + list(e.followUp).length,
          },
        ];
      case "compaction_start":
        return [...start(), { type: "activity", agent, activity: "compacting" }];
      case "compaction_end":
        return [];
      case "auto_retry_start":
      case "summarization_retry_scheduled":
        return [
          ...start(),
          {
            type: "retry",
            agent,
            on: "upstream",
            message: str(e.errorMessage),
            ...(typeof e.attempt === "number" ? { attempt: e.attempt } : {}),
          },
        ];
      case "auto_retry_end":
        if (e.success === false) outcome = "failed";
        return [];
      case "summarization_retry_finished":
        return [{ type: "retry.cleared", agent }];
      case "extension_error":
        return [notice(frame, str(e.error) || "Pi operation failed", "error")];
      case "response":
        return e.success === false
          ? [notice(frame, str(e.error) || "Pi operation failed", "error")]
          : [];
      case "entry_appended":
        return [];
      case "session_info_changed":
      case "thinking_level_changed":
        return [];
      case "turn_start":
        lastAnswer = undefined;
        return [];
      case "turn_end":
        return [];
      default:
        return [];
    }
  }
}
