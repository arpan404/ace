import type { Item } from "@ace/protocol";

/*
 * ace refusing one of its own agent tools (a delegation over the parent's permission ceiling,
 * past the tree's budget): one compact failed row, not an error block. The daemon reports each
 * refusal as an error notice; an agent that retries writes the same refusal again, and
 * consecutive identical ones read as one row with a count. Pure.
 */

export interface ToolRefusal {
  /** What was refused, in two or three words: "Delegation refused". */
  label: string;
  /** The short reason, once. */
  reason: string;
  /** More than the reason says, for a Details disclosure; absent when it would only repeat it. */
  detail?: string | undefined;
  /** Refusals with the same key are the same refusal. */
  key: string;
}

type Notice = Extract<Item, { type: "notice" }>;

const labels: Record<string, string> = {
  delegation_denied: "Delegation refused",
  delegation_limit: "Delegation limit reached",
  delegation_cancelled: "Delegation stopped",
};

function isRefusal(item: Item | undefined): item is Notice {
  if (item?.type !== "notice" || item.level !== "error") return false;
  if (item.raw.some((raw) => raw.type === "ace.agent_control.failed")) return true;
  return item.code !== undefined && item.code in labels;
}

/** `item` as a refused agent tool, when it is one. */
export function toolRefusal(item: Item | undefined): ToolRefusal | undefined {
  if (!isRefusal(item)) return undefined;
  const title = item.title?.trim();
  let reason = item.text.trim();
  // Reports that lead with their own title ("Child permissions exceed …. Choose …") say it once.
  if (title && reason.startsWith(title)) reason = reason.slice(title.length).replace(/^[.\s]+/, "");
  if (!reason) reason = title ?? "";
  const detail = item.detail?.trim();
  return {
    label: (item.code && labels[item.code]) ?? title ?? "Agent tool refused",
    reason,
    ...(detail && !reason.includes(detail) && detail !== title ? { detail } : {}),
    key: `${item.agentId}\u0000${item.code ?? ""}\u0000${reason}`,
  };
}

/** Work that can sit between two tries of the same call without making them separate events. */
function between(item: Item): boolean {
  return (
    item.type === "tool_call" ||
    item.type === "reasoning" ||
    (item.type === "notice" && item.level !== "error")
  );
}

/**
 * How many identical refusals the row at `index` stands for: 0 when an earlier row already
 * counts it, otherwise itself and the identical ones that follow with only tool calls,
 * reasoning or quiet notices between. Looks `span` items either way, never the whole thread.
 */
export function refusalCount(
  order: readonly string[],
  index: number,
  item: (id: string) => Item | undefined,
  span = 32,
): number {
  const own = toolRefusal(item(order[index] ?? ""));
  if (!own) return 1;
  const same = (at: number): boolean | undefined => {
    const other = item(order[at] ?? "");
    if (!other) return undefined;
    const refusal = toolRefusal(other);
    if (refusal) return refusal.key === own.key;
    return between(other) ? undefined : false;
  };
  for (let at = index - 1; at >= Math.max(0, index - span); at--) {
    const match = same(at);
    if (match === true) return 0;
    if (match === false) break;
  }
  let count = 1;
  for (let at = index + 1; at < Math.min(order.length, index + 1 + span); at++) {
    const match = same(at);
    if (match === true) count++;
    else if (match === false) break;
  }
  return count;
}
