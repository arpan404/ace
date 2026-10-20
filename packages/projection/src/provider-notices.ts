import type { Item } from "@ace/protocol";

/*
 * Notifications a provider writes for the model rather than the person: OpenCode's finished
 * `<shell>` and `<subagent>`, Claude Code's `<task-notification>` and `<agent-message>`. The
 * adapters mark new ones with `origin`; history stored before they did carries only the
 * synthetic flag and this shape (OpenCode's even as assistant messages). Only synthetic messages
 * qualify: the person's typed text is never one, whatever it looks like. Pure.
 */

export type ProviderNoticeKind = "background_completion" | "subagent_result" | "parent_agent";

type Message = Extract<Item, { type: "message" }>;

const shell = /^<shell id="[^"\n]*"[^>]*>[\s\S]*<\/shell>$/;
const subagent = /^<subagent sessionID="[^"\n]*"[^>]*>[\s\S]*<\/subagent>$/;
const notification = /^<task-notification>[\s\S]*<\/task-notification>$/;
const agentMessage = /^<agent-message from="[^"\n]*">\n?([\s\S]*?)\n?<\/agent-message>$/;

const textOf = (item: Message) =>
  item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/** OpenCode's own word for what a synthetic message reports (`metadata.source`), if kept. */
function nativeSource(item: Message): unknown {
  // Clients may hold an item without its raw payloads; the text shape decides then.
  const first = Array.isArray(item.raw) ? item.raw[0] : undefined;
  if (first?.type !== "projected.message" || !("data" in first)) return undefined;
  const data: unknown = first.data;
  if (typeof data !== "object" || data === null || !("metadata" in data)) return undefined;
  const metadata: unknown = data.metadata;
  return typeof metadata === "object" && metadata !== null && "source" in metadata
    ? metadata.source
    : undefined;
}

/** The ace input a provider-injected message stands for, or undefined. */
export function providerNotice(item: Item | undefined): ProviderNoticeKind | undefined {
  if (item?.type !== "message" || !item.synthetic) return undefined;
  const source = nativeSource(item);
  if (source === "shell") return "background_completion";
  if (source === "subagent") return "subagent_result";
  const text = textOf(item).trim();
  if (shell.test(text)) return "background_completion";
  if (subagent.test(text)) return "subagent_result";
  if (notification.test(text))
    return /<summary>Agent\b/.test(text) ? "subagent_result" : "background_completion";
  return agentMessage.test(text) ? "parent_agent" : undefined;
}

/**
 * The agent's own words: an assistant message that is not a provider notice stored before the
 * adapters classified them. Readers of "what the agent said" (answers, previews, results handed
 * to a parent) take only these.
 */
export function isAgentProse(item: Item | undefined): item is Message & { role: "assistant" } {
  return item?.type === "message" && item.role === "assistant" && !providerNotice(item);
}

/** What another agent said, without Claude's `<agent-message>` envelope. */
export function agentMessageBody(text: string): string | undefined {
  return agentMessage.exec(text.trim())?.[1];
}
