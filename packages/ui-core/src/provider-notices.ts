import type { Item } from "@ace/protocol";
import { messageText, type InputKind } from "./system-input.ts";

/*
 * Notifications a provider writes for the model rather than the person: OpenCode's finished
 * `<shell>` and `<subagent>`, Claude Code's `<task-notification>` and `<agent-message>`. The
 * adapters mark new ones with `origin`; history stored before they did carries only the
 * synthetic flag and this shape. Only synthetic messages qualify: the person's typed text is
 * never one, whatever it looks like. Pure.
 */

const shell = /^<shell id="[^"\n]*"[^>]*>[\s\S]*<\/shell>$/;
const subagent = /^<subagent sessionID="[^"\n]*"[^>]*>[\s\S]*<\/subagent>$/;
const notification = /^<task-notification>[\s\S]*<\/task-notification>$/;
const agentMessage = /^<agent-message from="[^"\n]*">\n?([\s\S]*?)\n?<\/agent-message>$/;

/** OpenCode's own word for what a synthetic message reports (`metadata.source`), if kept. */
function nativeSource(item: Extract<Item, { type: "message" }>): unknown {
  // Clients may hold an item without its raw payloads; the text shape decides then.
  const first = Array.isArray(item.raw) ? item.raw[0] : undefined;
  if (first?.type !== "projected.message") return undefined;
  const data: unknown = first.data;
  if (typeof data !== "object" || data === null || !("metadata" in data)) return undefined;
  const metadata: unknown = data.metadata;
  return typeof metadata === "object" && metadata !== null && "source" in metadata
    ? metadata.source
    : undefined;
}

/** The ace input a provider-injected message stands for, or undefined. */
export function providerNotice(item: Item): InputKind | undefined {
  if (item.type !== "message" || !item.synthetic) return undefined;
  const source = nativeSource(item);
  if (source === "shell") return "background_completion";
  if (source === "subagent") return "subagent_result";
  const text = messageText(item).trim();
  if (shell.test(text)) return "background_completion";
  if (subagent.test(text)) return "subagent_result";
  if (notification.test(text))
    return /<summary>Agent\b/.test(text) ? "subagent_result" : "background_completion";
  return agentMessage.test(text) ? "parent_agent" : undefined;
}

/** What another agent said, without Claude's `<agent-message>` envelope. */
export function agentMessageBody(text: string): string | undefined {
  return agentMessage.exec(text.trim())?.[1];
}
