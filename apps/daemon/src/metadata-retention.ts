import type { ThreadView } from "@ace/protocol";

export type AgentMetadataCollection = "usage" | "contextMeters";

/** Keep metadata for retained agents plus a bounded recent window awaiting agent linkage. */
export function trimAgentMetadata(view: ThreadView, collection: AgentMetadataCollection): void {
  const values = view[collection];
  if (!values) return;
  let count = 0;
  let bytes = 0;
  for (const [id, value] of Object.entries(values).toReversed()) {
    if (Object.hasOwn(view.agents, id)) continue;
    const size = Buffer.byteLength(JSON.stringify(value));
    if (count >= 200 || bytes + size > 131072) delete values[id];
    else {
      count++;
      bytes += size;
    }
  }
}
