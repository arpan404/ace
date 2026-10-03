import type { Fact, Key } from "@ace/core";
import { boundedJson } from "@ace/provider-kit/ipc";
import { object, nativeIdentity, string, type CursorEnvelope } from "./contracts.ts";
import { toolKind, toolDetail, toolStatus } from "./tools.ts";
import type { Children } from "./children.ts";
import type { Transcript } from "./transcript.ts";
interface Tool {
  agent: Key;
  name: string;
  args: unknown;
  argsBytes: number;
  terminal: boolean;
  failed: boolean;
  output: boolean;
  surviving: boolean;
}
export class ToolEvents {
  readonly calls = new Map<Key, Tool>();
  private retainedBytes = 0;
  private pendingByOwner = new Map<Key, Set<Key>>();
  constructor(privateOptions: { children: Children; limit: number; retainedLimit: number }) {
    this.children = privateOptions.children;
    this.limit = privateOptions.limit;
    this.retainedLimit = privateOptions.retainedLimit;
  }
  private children: Children;
  private limit: number;
  private retainedLimit: number;
  trim(): void {
    for (const [key, tool] of this.calls)
      if (tool.terminal) {
        this.calls.delete(key);
        this.retainedBytes -= tool.argsBytes;
      }
  }
  translate(
    body: Record<string, unknown>,
    agent: Key,
    namespace: string,
    event: CursorEnvelope | undefined,
    transcript: Transcript,
    operation: string | undefined,
    segment: number,
    cwd: string,
    notice: (text: string, data: unknown, level?: "info" | "warning" | "error") => Fact,
  ): Fact[] {
    const type = string(body.type);
    if (
      type === "tool-call-started" ||
      type === "partial-tool-call" ||
      type === "tool-call-completed"
    ) {
      const callId = nativeIdentity(body.callId);
      if (!callId) return [notice("SDK tool update lacks native call identity", event, "warning")];
      const call = `${namespace}:call:${callId}`;
      const native = object(body.toolCall);
      const name =
        nativeIdentity(native.name) ??
        nativeIdentity(native.type) ??
        this.calls.get(call)?.name ??
        "unknown";
      let tool = this.calls.get(call);
      if (!tool) {
        if (this.calls.size + this.children.calls.size >= this.limit)
          throw new Error("SDK identity cap");
        tool = {
          agent,
          name,
          args: undefined,
          argsBytes: 0,
          terminal: false,
          failed: false,
          output: false,
          surviving: false,
        };
        this.calls.set(call, tool);
        let pending = this.pendingByOwner.get(agent);
        if (!pending) {
          pending = new Set();
          this.pendingByOwner.set(agent, pending);
        }
        pending.add(call);
      }
      tool.name = name;
      if (native.args !== undefined) {
        const argsBytes = Buffer.byteLength(boundedJson(native.args, 262144));
        if (this.retainedBytes - tool.argsBytes + argsBytes > this.retainedLimit)
          throw new Error("SDK retained tool argument budget exceeded");
        this.retainedBytes += argsBytes - tool.argsBytes;
        tool.argsBytes = argsBytes;
        tool.args = native.args;
      }
      const status = toolStatus(
        type === "tool-call-completed" ? "completed" : "running",
        native.result,
      );
      tool.failed ||= status === "failed";
      if (tool.terminal && type !== "tool-call-completed") return [];
      tool.terminal ||= status !== "running";
      if (tool.terminal || toolKind(tool.name) === "agent.spawn") {
        const pending = this.pendingByOwner.get(tool.agent);
        pending?.delete(call);
        if (pending?.size === 0) this.pendingByOwner.delete(tool.agent);
      }
      const staleCompletion = event?.operationId !== operation || event?.segment !== segment;
      const facts = staleCompletion ? [] : transcript.boundary(agent);
      if (tool.terminal && tool.surviving) {
        tool.surviving = false;
        facts.push({
          type: "background.ended",
          task: `surviving:${call}`,
          status: tool.failed ? "failed" : "completed",
        });
      }
      if (toolKind(name) === "agent.spawn") {
        facts.push(...this.children.ensure(call, agent, tool.args, cwd));
        if (tool.terminal) {
          const child = this.children.calls.get(call);
          const result = this.children.result(call, native.result, tool.failed, cwd);
          if (child && result.some((fact) => fact.type === "turn.ended"))
            facts.push(
              ...transcript.boundary(child.key),
              ...this.preserve(child.key),
              ...this.children.preserveOwned(child.key),
            );
          facts.push(...result);
        }
      }
      facts.push({
        type: "item.upsert",
        agent,
        item: call,
        draft: {
          type: "tool_call",
          complete: tool.terminal,
          call: {
            kind: toolKind(name),
            title: name,
            status: tool.failed ? "failed" : status,
            detail: toolDetail(name, tool.args, native.result),
            raw: [event?.raw ?? { type: "cursor.sdk.tool", name, data: event }],
            ...(tool.failed
              ? { error: "Cursor tool failed or was denied by execution policy" }
              : {}),
          },
        },
      });
      if (event?.raw)
        facts.push(
          notice(
            "SDK semantic preview is bounded; full redacted raw data is retained in the referenced blob",
            event,
            "warning",
          ),
        );
      const truncation = object(native.truncated);
      if (truncation.args === true || truncation.result === true)
        facts.push(
          notice("Cursor SDK tool args/result were truncated by the SDK", event, "warning"),
        );
      const result = object(object(native.result).value);
      if (
        toolKind(name) === "shell" &&
        tool.terminal &&
        !tool.output &&
        body.aceOutputStream !== true
      ) {
        const output = (string(result.stdout) ?? "") + (string(result.stderr) ?? "");
        if (output)
          facts.push({ type: "item.delta", agent, item: call, field: "output", append: output });
        tool.output = true;
      }
      return facts;
    }
    return [];
  }
  output(
    body: Record<string, unknown>,
    agent: Key,
    namespace: string,
    event: CursorEnvelope,
    transcript: Transcript,
    operation: string | undefined,
    segment: number,
    cwd: string,
    notice: (text: string, data: unknown, level?: "info" | "warning" | "error") => Fact,
  ): Fact[] {
    const id = nativeIdentity(body.callId),
      text = string(body.text);
    if (!id || !text) return [];
    const key = `${namespace}:call:${id}`;
    let tool = this.calls.get(key);
    const facts: Fact[] = [];
    if (!tool) {
      facts.push(
        ...this.translate(
          { type: "tool-call-started", callId: id, toolCall: body.toolCall },
          agent,
          namespace,
          event,
          transcript,
          operation,
          segment,
          cwd,
          notice,
        ),
      );
      tool = this.calls.get(key);
    }
    if (!tool || toolKind(tool.name) !== "shell" || tool.terminal) return facts;
    tool.output = true;
    facts.push({ type: "item.delta", agent: tool.agent, item: key, field: "output", append: text });
    return facts;
  }
  preserve(owner?: Key): Fact[] {
    const facts: Fact[] = [];
    const owners = owner === undefined ? this.pendingByOwner.keys() : [owner];
    for (const key of owners) {
      const pending = this.pendingByOwner.get(key);
      if (!pending) continue;
      for (const item of pending) {
        const tool = this.calls.get(item);
        if (tool && !tool.terminal && !tool.surviving && toolKind(tool.name) !== "agent.spawn") {
          tool.surviving = true;
          pending.delete(item);
          facts.push({
            type: "background.started",
            agent: tool.agent,
            task: `surviving:${item}`,
            kind: toolKind(tool.name) === "shell" ? "shell" : "other",
            title: `Unresolved SDK ${tool.name}`,
            item,
            stoppable: false,
          });
          facts.push({
            type: "background.ended",
            task: `surviving:${item}`,
            status: "unknown",
            uncertain: true,
          });
        }
      }
      if (!pending.size) this.pendingByOwner.delete(key);
    }
    return facts;
  }
}
