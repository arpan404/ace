import type { Fact, Key } from "@ace/core";
import type { Translator, Frame } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import { Dialog, Envelope, obj, str, list } from "./native.ts";
import { dialogRequest } from "./dialogs.ts";
import { toolDetail, resultText } from "./tools.ts";

const raw = (data: unknown) => [{ type: str(obj(data).type) || "unknown", data }];
export function createPiTranslator(init: { threadId: ThreadId; rootKey: Key }): Translator {
  const agent = init.rootKey;
  let run = 0,
    active = false,
    message = 0,
    outcome: "completed" | "failed" | "interrupted" = "completed";
  let poisoned = false;
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
      notice(frame, "Pi live bookkeeping limit exceeded; completion is uncertain", "error"),
      { type: "agent.disconnected", agent },
    ];
  }
  return {
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
      return facts;
    },
    translate(frame, now) {
      const decoded = Envelope.safeParse(frame.data);
      if (!decoded.success)
        return frame.dir === "stderr"
          ? [notice(frame, str(frame.data), "warning")]
          : [notice(frame, "Unrecognized Pi frame")];
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
          return [
            { type: "process.exited", deliberate: e.deliberate === true, message: str(e.message) },
          ];
        }
        if (e.type === "dialog_expired") {
          const id = str(e.id);
          if (!dialogs.delete(id)) return [];
          refreshDeadline();
          return [{ type: "interaction.closed", interaction: id, state: "expired" }];
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
          facts.push(
            { type: "retry.cleared", agent },
            { type: "turn.ended", agent, nativeTurnId: `${prefix}:run:${run}`, outcome },
          );
          active = false;
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
          const m = obj(e.message),
            facts: Fact[] = [];
          if (m.role === "assistant") {
            list(m.content).forEach((block, index) => {
              const b = obj(block);
              if (b.type !== "text" && b.type !== "thinking") return;
              facts.push({
                type: "item.upsert",
                agent,
                item: `${prefix}:message:${message}:${index}`,
                draft:
                  b.type === "text"
                    ? {
                        type: "message",
                        role: "assistant",
                        complete: true,
                        ...(!streamed.has(index)
                          ? { parts: [{ type: "text", text: str(b.text) }] }
                          : {}),
                        raw: raw(e),
                      }
                    : {
                        type: "reasoning",
                        complete: true,
                        ...(!streamed.has(index) ? { text: str(b.thinking) } : {}),
                        raw: raw(e),
                      },
              });
            });
            if (["stop", "length"].includes(str(m.stopReason))) outcome = "completed";
            if (m.stopReason === "aborted") outcome = "interrupted";
            if (m.stopReason === "error") outcome = "failed";
            const u = obj(m.usage),
              cost = obj(u.cost);
            if (typeof u.input === "number" && typeof u.output === "number")
              facts.push({
                type: "usage",
                agent,
                inputTokens: u.input,
                outputTokens: u.output,
                ...(typeof u.cacheRead === "number" ? { cachedInputTokens: u.cacheRead } : {}),
                ...(typeof cost.total === "number" ? { costUsd: cost.total } : {}),
              });
          } else if (m.role === "user")
            facts.push({
              type: "item.upsert",
              agent,
              item: `${prefix}:user:${message}`,
              draft: {
                type: "message",
                role: "user",
                complete: true,
                parts: [
                  { type: "text", text: typeof m.content === "string" ? m.content : resultText(m) },
                ],
                raw: raw(e),
              },
            });
          return facts;
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
                  raw: raw(e),
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
          const text = resultText(e.type === "tool_execution_end" ? e.result : e.partialResult);
          if (tool.name === "bash" && text.length > tool.length) {
            facts.push({
              type: "item.delta",
              agent,
              item: `${prefix}:tool:${id}`,
              field: "output",
              append: text.slice(tool.length),
            });
            tool.length = text.length;
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
                  raw: raw(e),
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
          const p = Dialog.safeParse(e);
          if (!p.success)
            return [
              notice(
                frame,
                str(e.message) || str(e.statusText) || str(e.title) || "Pi extension UI update",
              ),
            ];
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
              raw: raw(e),
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
          return [notice(frame, "Pi compaction finished")];
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
          return [notice(frame, str(e.error), "error")];
        case "response":
          return e.success === false ? [notice(frame, str(e.error), "error")] : [];
        case "entry_appended":
          return [notice(frame, "Pi native history entry appended")];
        case "session_info_changed":
        case "thinking_level_changed":
        case "turn_start":
        case "turn_end":
          return [];
        default:
          return [notice(frame, `Unknown Pi event: ${e.type}`)];
      }
    },
  };
}
