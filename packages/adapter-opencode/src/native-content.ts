import { z } from "zod";
import type { Fact, ToolDetailDraft } from "@ace/core";
import { array, object, raw, string, number, type Data } from "./data.ts";
import { NativeState, type Tool } from "./native-state.ts";
export function toolKey(session: string, message: string, id: string): string {
  return `tool:${session}:${message}:${id}`;
}
export function contentKey(p: Data): string {
  return `${string(p.sessionID)}:${string(p.assistantMessageID)}:${number(p.ordinal)}`;
}
function detail(name: string, input: Data): ToolDetailDraft {
  if (name === "shell") return { kind: "shell", command: string(input.command) };
  if (name === "subagent")
    return { kind: "agent.spawn", prompt: string(input.prompt), agentType: string(input.agent) };
  if (name === "read") return { kind: "file.read", path: string(input.filePath) };
  if (name === "edit" || name === "write")
    return { kind: "file.edit", changes: [{ path: string(input.filePath), kind: "update" }] };
  return { kind: "custom" };
}
export function tool(state: NativeState, p: Data, type: string, evidence: unknown): Fact[] {
  const id = string(p.sessionID),
    message = string(p.assistantMessageID),
    item = toolKey(id, message, string(p.id));
  const previous = state.tools.get(item) ?? state.recentTools.get(item);
  const native = object(p.state),
    meta = object(p.metadata ?? native.metadata);
  const name = string(p.name, previous?.name ?? "unknown");
  let endedInput: unknown;
  if (type === "session.tool.input.ended") {
    const endedText = z.string().max(65536).safeParse(p.text);
    if (endedText.success) {
      try {
        endedInput = JSON.parse(endedText.data);
      } catch {
        /* Incomplete/unknown input remains raw evidence. */
      }
    }
  }
  const supplied =
    p.input ??
    native.input ??
    (type === "session.tool.input.ended" ? (endedInput ?? {}) : undefined);
  const source = supplied === undefined ? (previous?.input ?? {}) : object(supplied);
  // Exact command/path/cwd fields serve approval attribution; display fields stay bounded.
  // Core retains the complete native input in raw evidence.
  const input =
    supplied === undefined
      ? source
      : {
          ...(typeof source.command === "string" && source.command.length <= 8192
            ? { command: source.command }
            : {}),
          ...(string(source.path, string(source.filePath)).length <= 4096
            ? { filePath: string(source.path, string(source.filePath)) }
            : {}),
          ...(typeof source.workdir === "string" ? { workdir: source.workdir } : {}),
          ...(typeof source.cwd === "string" ? { cwd: source.cwd } : {}),
          prompt: string(source.prompt).slice(0, 8192),
          agent: string(source.agent).slice(0, 256),
          background: source.background === true,
        };
  const failed = type === "session.tool.failed" || native.status === "error";
  const complete = failed || type === "session.tool.success" || native.status === "completed";
  if (previous && !previous.live && !complete) return [];
  const created =
    previous?.created ??
    number(object(p.time).created, number(object(evidence).created, Number.MAX_SAFE_INTEGER));
  const current: Tool = { session: id, message, name, input, live: !complete, created };
  state.trackTool(item, current);
  const d = detail(name, input),
    blocks = array(p.content ?? native.content);
  const output = blocks.map((v) => string(object(v).text)).join("\n");
  const facts: Fact[] = [
    {
      type: "item.reconciled",
      agent: state.key(id),
      item,
      draft: {
        type: "tool_call",
        complete,
        call: {
          kind: d.kind,
          title: name,
          status: complete
            ? failed
              ? "failed"
              : "succeeded"
            : type.endsWith("input.started")
              ? "pending"
              : "running",
          detail: { ...d, ...(d.kind === "shell" ? { output } : {}) },
          raw: raw(type, evidence, name),
          ...(failed
            ? { error: string(object(p.error ?? native.error).message, "Tool failed") }
            : {}),
        },
      },
    },
  ];
  // A running tool is work even if an execution terminal arrives before cleanup.
  if (!complete) facts.push(...state.background(`work:${item}`, id, "other", item));
  else facts.push(...state.finishBackground(`work:${item}`, failed ? "failed" : "completed"));
  const child = string(meta.sessionID);
  if (name === "subagent" && child && !state.agents.has(child)) {
    if (state.childClaims.size >= 1024 && !state.childClaims.has(child))
      throw new Error("OpenCode child evidence limit");
    state.childClaims.set(child, {
      session: id,
      item,
      background: input.background === true,
      created,
    });
    facts.push(...state.background(`proof:${child}`, id, "other", item));
  }
  if (name === "subagent" && child && state.agents.get(child)?.parent === id) {
    facts.push({
      type: "agent.linked",
      agent: state.key(child),
      parent: state.key(id),
      spawnedBy: item,
      background: input.background === true,
    });
    if (input.background === true) facts.push(...state.childDispatch(child, id, item, created));
  }
  const shell = string(meta.shellID);
  if (
    name === "shell" &&
    shell &&
    !(type === "snapshot.tool" && complete && !state.shells.has(shell))
  ) {
    if (state.shells.size >= 2048 && !state.shells.has(shell))
      throw new Error("OpenCode shell limit");
    state.shells.set(shell, id);
    if (input.background === true || meta.status === "running") state.wakeShells.add(shell);
    facts.push(...state.background(`shell:${shell}`, id, "shell", item));
  }
  return facts;
}
export function text(state: NativeState, type: string, p: Data, evidence: unknown): Fact[] {
  const agent = state.key(string(p.sessionID)),
    item = `${type.includes("reasoning") ? "reasoning" : "text"}:${contentKey(p)}`;
  const reasoning = type.includes("reasoning"),
    complete = type.endsWith("ended");
  if (type.endsWith("delta"))
    return [
      {
        type: "item.delta",
        agent,
        item,
        field: reasoning ? "reasoning" : "text",
        append: string(p.delta),
      },
    ];
  return [
    {
      type: "item.reconciled",
      agent,
      item,
      draft: reasoning
        ? {
            type: "reasoning",
            text: string(p.text),
            summary: false,
            complete,
            raw: raw(type, evidence),
          }
        : {
            type: "message",
            role: "assistant",
            parts: [{ type: "text", text: string(p.text) }],
            complete,
            raw: raw(type, evidence),
          },
    },
  ];
}
export function projected(state: NativeState, session: string, value: unknown): Fact[] {
  const p = object(value),
    message = string(p.id),
    agent = state.key(session);
  if (p.type === "assistant")
    return array(p.content).flatMap((block, ordinal) => {
      const c = object(block),
        data = { ...c, sessionID: session, assistantMessageID: message, ordinal };
      return c.type === "tool"
        ? tool(state, data, "snapshot.tool", c)
        : c.type === "text" || c.type === "reasoning"
          ? text(
              state,
              `session.${c.type}.${typeof object(p.time).completed === "number" ? "ended" : "started"}`,
              data,
              c,
            )
          : [];
    });
  if (p.type === "user" || p.type === "synthetic" || p.type === "system")
    return [
      ...(p.type === "synthetic"
        ? state.completion(object(p.metadata), number(object(p.time).created, -1))
        : []),
      {
        type: "item.reconciled",
        agent,
        item: `message:${session}:${message}`,
        draft: {
          type: "message",
          ...(message && message.length <= 256 ? { nativeId: message } : {}),
          role: p.type === "user" ? "user" : "assistant",
          synthetic: p.type === "synthetic",
          parts: [{ type: "text", text: string(p.text) }],
          complete: true,
          raw: raw("projected.message", p),
        },
      },
    ];
  // Idle markers are historical evidence. A fresh info/active snapshot owns turn settlement.
  if (p.type === "idle") return [];
  return [];
}
