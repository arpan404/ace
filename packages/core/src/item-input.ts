import { normalizeAceCall } from "./ace-tools.ts";
import type { AgentId, Item, ItemId, RunId, ToolDetail } from "@ace/protocol";
import { summarizeOutput } from "@ace/projection";
import type { ToolDetailDraft, ItemDraft } from "./facts.ts";

export interface ItemIdentity {
  id: ItemId;
  agentId: AgentId;
  createdAt: number;
  runId?: RunId;
}

/** Partial details inherit their kind from the call or existing item. */
export function itemDetailKind(
  previous: Item | undefined,
  patch: ItemDraft,
): ToolDetail["kind"] | undefined {
  if (patch.type !== "tool_call") return undefined;
  return (
    patch.call?.detail?.kind ??
    patch.call?.kind ??
    (previous?.type === "tool_call" ? previous.call.detail.kind : undefined)
  );
}

/** Pure candidate construction lets validation finish before identity allocation. */
export function itemInput(
  previous: Item | undefined,
  base: ItemIdentity,
  patch: ItemDraft,
  now: number,
  detailPatch?: Partial<ToolDetail> | ToolDetailDraft,
): unknown {
  if (patch.type === "tool_call") {
    const normalized = normalizeAceCall(
      patch.call ?? {},
      previous?.type === "tool_call" ? previous.call : undefined,
    );
    patch = { ...patch, call: normalized };
    if (normalized.detail?.kind === "mcp") detailPatch = normalized.detail;
    const priorCall = previous?.type === "tool_call" ? previous.call : undefined;
    const detail = patch.call?.detail;
    const kind = patch.call?.kind ?? itemDetailKind(previous, patch) ?? "custom";
    const detailChanges: Record<string, unknown> = { ...detailPatch };
    if (detailChanges.output === undefined) delete detailChanges.output;
    const mergedDetail: Record<string, unknown> = {
      ...(priorCall?.detail.kind === (detail?.kind ?? kind) ? priorCall.detail : { kind }),
      ...detailChanges,
    };
    if (mergedDetail.kind === "shell" && typeof mergedDetail.output === "string")
      mergedDetail.output = summarizeOutput(base.id, mergedDetail.output);
    if (mergedDetail.kind === "shell" && typeof mergedDetail.outputTruncated === "boolean")
      delete mergedDetail.outputTruncated;
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
        detail: mergedDetail,
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
