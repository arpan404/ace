import { basename } from "node:path";
import { CodexSessionMeta, object, string, timestamp } from "@ace/native-session";
import { HistorySession } from "@ace/protocol/history";
import type { ProviderHome } from "./contracts.ts";
import { createHash } from "node:crypto";

export function sourceId(instance: string, path: string, nativeId: string): string {
  return createHash("sha256").update(`${instance}\0${path}\0${nativeId}`).digest("hex");
}
export function summary(
  instance: ProviderHome,
  path: string,
  records: unknown[],
  exact: boolean,
  mtime: number,
): HistorySession {
  let nativeId = basename(path, ".jsonl");
  let cwd = "";
  let title = "";
  let model: string | undefined;
  let parent: string | undefined;
  let count = 0;
  let lastActivity = mtime;
  let reason: string | undefined;
  for (const value of records) {
    const r = object(value);
    const payload = object(r.payload);
    const message = object(r.message);
    cwd = string(r.cwd) ?? string(payload.cwd) ?? string(r.directory) ?? cwd;
    model = string(message.model) ?? string(r.model) ?? string(payload.model) ?? model;
    if (instance.provider === "codex") {
      const meta = CodexSessionMeta.safeParse(r).data;
      if (meta) {
        nativeId = meta.payload.id;
        parent = meta.payload.parent_thread_id ?? undefined;
        if (
          (meta.payload.history_mode && meta.payload.history_mode !== "legacy") ||
          meta.payload.history_base != null
        )
          reason = "Paginated Codex history requires provider-owned materialization";
      }
    } else nativeId = string(r.sessionId) ?? string(r.session_id) ?? string(r.id) ?? nativeId;
    if (r.type === "ai-title") title = string(r.aiTitle) ?? string(r.title) ?? title;
    if (typeof r.customTitle === "string") title = r.customTitle;
    if (r.type === "summary") title = string(r.summary) ?? title;
    if (
      r.type === "response_item" &&
      payload.type === "message" &&
      ["user", "assistant"].includes(String(payload.role))
    )
      count++;
    if (r.type === "user" || r.type === "assistant") count++;
    const content = message.content ?? payload.content;
    if (!title && (r.type === "user" || payload.role === "user")) {
      if (typeof content === "string") title = content.slice(0, 120);
      else if (Array.isArray(content))
        title = content
          .map((p) => string(object(p).text) ?? "")
          .join(" ")
          .slice(0, 120);
    }
    lastActivity = Math.max(lastActivity, timestamp(r.timestamp) ?? 0);
  }
  if (instance.provider === "codex" && !records.some((r) => CodexSessionMeta.safeParse(r).success))
    reason = "Unrecognized Codex rollout metadata";
  if (!cwd) reason ??= "Workspace metadata was not available in the bounded sample";
  return HistorySession.parse({
    id: sourceId(instance.id, path, nativeId),
    instanceId: instance.id,
    provider: instance.provider,
    nativeId,
    cwd,
    title: (title || nativeId).slice(0, 256),
    ...(model ? { model: model.slice(0, 512) } : {}),
    ...(parent ? { parentNativeId: parent } : {}),
    lastActivity,
    messageCount: count,
    countAccuracy: exact ? "exact" : "sampled",
    support: reason ? { status: "unsupported", reason } : { status: "supported" },
  });
}
