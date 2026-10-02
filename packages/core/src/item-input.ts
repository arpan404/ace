import type { AgentId, Item, ItemId, RunId, ToolDetail } from "@ace/protocol";
import type { ItemDraft } from "./facts.ts";

export interface ItemIdentity {
  id: ItemId;
  agentId: AgentId;
  createdAt: number;
  runId?: RunId;
}

/** Pure candidate construction lets validation finish before identity allocation. */
export function itemInput(
  previous: Item | undefined,
  base: ItemIdentity,
  patch: ItemDraft,
  now: number,
  detailPatch?: Partial<ToolDetail>,
): unknown {
  if (patch.type === "tool_call") {
    const priorCall = previous?.type === "tool_call" ? previous.call : undefined;
    const detail = patch.call?.detail;
    const kind = patch.call?.kind ?? detail?.kind ?? priorCall?.kind ?? "custom";
    return {
      ...(previous?.type === patch.type ? previous : { complete: false }),
      ...patch,
      ...base,
      call: {
        title: kind,
        status: "pending",
        startedAt: now,
        raw: [],
        ...priorCall,
        ...patch.call,
        id: base.id,
        agentId: base.agentId,
        kind,
        detail: {
          ...(priorCall?.detail.kind === (detail?.kind ?? kind) ? priorCall.detail : { kind }),
          ...detailPatch,
        },
      },
    };
  }
  const defaults =
    patch.type === "message"
      ? { role: "assistant", parts: [] }
      : patch.type === "reasoning"
        ? { text: "" }
        : patch.type === "notice"
          ? { level: "info", text: "" }
          : {};
  return {
    complete: false,
    ...defaults,
    ...(previous?.type === patch.type ? previous : {}),
    ...patch,
    ...base,
  };
}
