import { lstat } from "node:fs/promises";
import { Agent, AgentId, Item, ItemId, Thread, type RawPayload } from "@ace/protocol";
import { fingerprint, object, string } from "@ace/native-session";
import type { Catalog, Source } from "./catalog.ts";
import type { ImportInit, Packet, ProviderHome } from "./contracts.ts";
import { sourceRecords } from "./source-records.ts";
import { completeHistoryTool } from "./complete-history-tool.ts";
import { prepareHistory } from "./history-plan.ts";
import { nativeCallId } from "./native-tools.ts";
import { mapHistory } from "./map-history.ts";
import { databaseFingerprint, storageFingerprint } from "./fingerprints.ts";

export async function currentFingerprint(
  instance: ProviderHome,
  source: Source,
  signal: AbortSignal,
) {
  return source.kind === "database"
    ? databaseFingerprint(source.path)
    : source.kind === "storage"
      ? storageFingerprint(instance, source.path, signal)
      : fingerprint(await lstat(source.path));
}
export async function* importHistory(
  catalog: Catalog,
  instances: ProviderHome[],
  init: ImportInit,
  signal: AbortSignal,
): AsyncGenerator<Packet> {
  const root = catalog.get(init.sourceId);
  if (!root) throw new Error("Unknown history source");
  const instance = instances.find((i) => i.id === root.instanceId);
  if (!instance) throw new Error("History instance is no longer registered");
  if (root.summary.support.status === "unsupported") throw new Error(root.summary.support.reason);
  const sources: { source: Source; agentId: AgentId; parentId: AgentId | null }[] = [];
  const seen = new Set<string>();
  const collect = (source: Source, parentId: AgentId | null, depth: number) => {
    if (depth > 16 || sources.length >= 512) throw new Error("Imported agent tree limit exceeded");
    if (seen.has(source.summary.id)) throw new Error("Cyclic history agent tree");
    seen.add(source.summary.id);
    const agentId = AgentId.parse(
      parentId === null ? init.agentId : `${init.agentId}:${source.summary.id}`,
    );
    sources.push({ source, agentId, parentId });
    for (const child of catalog.children(instance.id, source.summary.nativeId))
      collect(child, agentId, depth + 1);
  };
  collect(root, null, 0);
  for (const { source } of sources) {
    if (source.summary.support.status === "unsupported")
      throw new Error(source.summary.support.reason);
    if ((await currentFingerprint(instance, source, signal)) !== source.fingerprint)
      throw new Error("History source changed; rescan before importing");
  }
  const native = { provider: root.summary.provider, nativeId: root.summary.nativeId };
  yield {
    type: "thread",
    thread: Thread.parse({
      id: init.threadId,
      workspaceId: init.workspaceId,
      title: root.summary.title,
      provider: root.summary.provider,
      rootAgentId: init.agentId,
      status: { state: "new" },
      createdAt: init.at,
      updatedAt: init.at,
      imported: { sourceId: init.sourceId, instanceId: instance.id, native, importedAt: init.at },
    }),
  };
  let rootCount = 0;
  let countAccuracy: "exact" | "sampled" = "exact";
  for (const { source, agentId, parentId } of sources) {
    const s = source.summary;
    yield {
      type: "agent",
      agent: Agent.parse({
        id: agentId,
        threadId: init.threadId,
        parentId,
        origin: parentId ? "provider_subagent" : "root",
        native: { provider: s.provider, nativeId: s.nativeId },
        fidelity: "full",
        cwd: s.cwd,
        model: s.model,
        status: { state: "unresponsive", lastSignalAt: s.lastActivity },
        createdAt: init.at,
      }),
    };
    const plan = await prepareHistory(instance, source, catalog.scratchRoot, signal);
    try {
      let seq = 0;
      let ordinal = 0;
      for await (const record of sourceRecords(instance, source, signal, catalog.scratchRoot)) {
        signal.throwIfAborted();
        if (!plan.includes(++ordinal)) continue;
        const prefix = `${init.threadId}:${s.id}:${seq++}`;
        let raw: RawPayload;
        const r = "value" in record ? object(record.value) : {};
        if (record.bytes > 60 * 1024 || "opaque" in record) {
          const id = `${prefix}:raw`;
          yield { type: "blob.start", id, bytes: record.bytes };
          for await (const bytes of record.chunks()) yield { type: "blob.chunk", id, bytes };
          yield { type: "blob.end", id };
          raw = {
            type: (string(r.type) ?? "history.raw").slice(0, 256),
            blobRef: id,
            size: record.bytes,
            preview: "",
          };
        } else
          raw = {
            type: (string(r.type) ?? "history.raw").slice(0, 256),
            data: "value" in record ? record.value : null,
          };
        const p = s.provider === "codex" ? object(r.payload) : r;
        const blocks = s.provider === "claude" ? object(r.message).content : [p];
        const nativeCalls = (function* () {
          if (!Array.isArray(blocks)) return;
          for (const block of blocks) {
            const b = object(block);
            if (["tool_use", "function_call", "custom_tool_call"].includes(String(b.type)))
              yield nativeCallId(b);
          }
        })();
        if ("opaque" in record) {
          if (parentId === null) countAccuracy = "sampled";
          yield {
            type: "item",
            item: Item.parse({
              id: ItemId.parse(prefix),
              agentId,
              createdAt: init.at,
              complete: true,
              type: "notice",
              level: "warning",
              text: "Native record retained in a blob; oversized or incomplete JSON",
              raw: [raw],
            }),
          };
        } else
          for (const mapped of mapHistory(record.value, {
            provider: s.provider,
            agentId,
            idPrefix: prefix,
            at: init.at,
            raw,
            resultCall: (id) => {
              const item = plan.callItem(id);
              return item ? ItemId.parse(item) : undefined;
            },
          })) {
            if (mapped.item.type === "tool_call") {
              const nativeId = nativeCalls.next().value;
              if (nativeId) {
                plan.recordCall(nativeId, mapped.item.id);
                const completion = plan.completion(nativeId);
                if (completion) mapped.item = yield* completeHistoryTool(mapped.item, completion);
              }
            }
            if (parentId === null && mapped.message) rootCount++;
            yield { type: "item", item: mapped.item };
          }
      }
    } finally {
      await plan.close();
    }
  }
  yield { type: "barrier" };
  for (const { source } of sources)
    if ((await currentFingerprint(instance, source, signal)) !== source.fingerprint)
      throw new Error("History source changed during import");
  catalog.updateCount(root.summary.id, rootCount, countAccuracy);
  yield { type: "end", messageCount: rootCount, countAccuracy };
}
