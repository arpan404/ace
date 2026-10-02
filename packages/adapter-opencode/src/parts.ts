import type { Fact } from "@ace/core";
import { number, object, raw, string, type Data } from "./data.ts";
import { detail, toolStatus } from "./tools.ts";
import type { TranslationState } from "./translation-state.ts";
export function translatePart(state: TranslationState, p: Data): Fact[] {
  const id = string(p.sessionID);
  const agent = state.key(id);
  const s = state.session(id);
  const partId = string(p.id);
  if (!partId) return state.notice(p, "part without id");
  const item = p.type === "tool" ? string(p.callID, partId) : partId;
  const previous = state.getPart(partId);
  const nativeStatus = string(object(p.state).status);
  state.rememberPart(
    partId,
    item,
    p,
    p.type === "tool"
      ? ["pending", "running"].includes(nativeStatus)
      : (p.type === "text" || p.type === "reasoning") && typeof object(p.time).end !== "number",
  );
  const facts: Fact[] = [];
  const message = state.messages.get(string(p.messageID));
  if (p.type === "text" || p.type === "reasoning") {
    const text = string(p.text);
    const user = message?.role === "user";
    if (user && state.own.has(string(p.messageID))) {
      const path = /(?:<[^>]+>|[^\s<>]+)\/\.opencode\/plans\/[^\s<>]+\.md/.exec(text)?.[0];
      if (path) s.planPath = path;
    }
    const task =
      user && !state.own.has(string(p.messageID)) && p.synthetic === true
        ? /^<task id="([^"]+)" state="(completed|error)">/.exec(text)
        : null;
    if (task) state.delivered.add(string(task[1]));
    if (task && state.backgrounds.has(string(task[1]))) {
      s.trigger = "subagent_result";
      s.awaiting = true;
      facts.push(
        { type: "wake.expected", agent, until: Number.MAX_SAFE_INTEGER },
        {
          type: "background.ended",
          task: string(task[1]),
          status: task[2] === "error" ? "failed" : "completed",
        },
      );
      state.backgrounds.delete(string(task[1]));
      state.graceDirty = true;
    }
    facts.push({
      type: "item.upsert",
      agent,
      item,
      draft:
        p.type === "reasoning"
          ? {
              type: "reasoning",
              text,
              complete: typeof object(p.time).end === "number",
              summary: false,
              raw: raw("message.part.updated", p),
            }
          : {
              type: "message",
              role: user ? "user" : "assistant",
              parts: [{ type: "text", text }],
              complete: user || typeof object(p.time).end === "number",
              synthetic: p.synthetic === true,
              raw: raw("message.part.updated", p),
            },
    });
    if (!user && s.active) {
      s.hasParts = true;
      facts.push({
        type: "activity",
        agent,
        activity: p.type === "reasoning" ? "thinking" : "responding",
      });
    }
  } else if (p.type === "tool") {
    s.hasParts = true;
    const nativeState = object(p.state);
    const live = state.liveTools.get(id) ?? new Set<string>();
    const previousSize = live.size;
    if (["pending", "running"].includes(string(nativeState.status))) live.add(partId);
    else live.delete(partId);
    state.liveToolCount += live.size - previousSize;
    if (live.size) state.liveTools.set(id, live);
    else state.liveTools.delete(id);
    const meta = object(nativeState.metadata);
    const input = object(nativeState.input);
    const name = string(p.tool);
    const filePath = string(input.filePath);
    if (
      name === "write" &&
      nativeState.status === "completed" &&
      /(?:^|\/)\.opencode\/plans\/.*\.md$/.test(filePath) &&
      typeof input.content === "string"
    ) {
      s.planPath = filePath;
      s.planMarkdown = input.content;
    }
    if (
      name === "edit" &&
      nativeState.status === "completed" &&
      s.planPath === filePath &&
      s.planMarkdown !== undefined &&
      typeof input.oldString === "string" &&
      typeof input.newString === "string"
    )
      s.planMarkdown =
        input.replaceAll === true
          ? s.planMarkdown.replaceAll(input.oldString, input.newString)
          : s.planMarkdown.replace(input.oldString, input.newString);

    const child = string(meta.sessionId);
    const d = detail(name, input, meta, state.mcp);
    if (d.kind === "agent.spawn") delete d.childAgent;
    let status = toolStatus(nativeState, s.abort && (!message || message.parentID === s.turn));
    if (
      [...state.pending.values()].some((v) => v.item === item) &&
      (status === "running" || status === "pending")
    )
      status = "awaiting_approval";
    facts.push({
      type: "item.upsert",
      agent,
      item,
      draft: {
        type: "tool_call",
        complete: !["pending", "running", "awaiting_approval"].includes(status),
        call: {
          kind: d.kind,
          title: string(nativeState.title, name),
          status,
          detail: {
            ...d,
            ...(d.kind === "shell"
              ? { output: string(nativeState.output, string(meta.output)) }
              : {}),
          },
          raw: raw("message.part.updated", p, name),
          ...(typeof nativeState.error === "string" ? { error: nativeState.error } : {}),
        },
      },
    });
    if (name === "task" && child) {
      facts.push({
        type: "agent.linked",
        agent: state.key(child),
        parent: agent,
        spawnedBy: item,
        background: meta.background === true,
      });
      if (
        meta.background === true &&
        !state.delivered.has(child) &&
        !state.backgrounds.has(child) &&
        object(object(previous?.data.state).metadata).background !== true
      ) {
        state.graceDirty = true;
        state.backgrounds.set(child, { agent: id, child, item });
        facts.push({
          type: "background.started",
          agent,
          task: child,
          kind: "subagent",
          title: string(input.description, "Background subagent"),
          item,
          childAgent: state.key(child),
          stoppable: true,
          raw: raw("task", p, name),
        });
      }
    }
    const survivor = `survivor:${item}`;
    if (
      !["pending", "running", "awaiting_approval"].includes(status) &&
      state.backgrounds.has(survivor)
    ) {
      facts.push({
        type: "background.ended",
        task: survivor,
        status: status === "cancelled" ? "stopped" : status === "failed" ? "failed" : "completed",
      });
      state.backgrounds.delete(survivor);
      state.graceDirty = true;
    }
  } else if (p.type === "step-finish") {
    const tokens = object(p.tokens);
    facts.push({
      type: "usage",
      agent,
      inputTokens: number(tokens.input),
      outputTokens: number(tokens.output),
      cachedInputTokens: number(object(tokens.cache).read),
      costUsd: number(p.cost),
    });
  } else facts.push(...state.notice(p, string(p.type, "unknown part")));
  return facts;
}
