import { sessionTitle, userPrompt } from "./user-text.ts";
import { basename } from "node:path";
import {
  ClaudeSessionMeta,
  CodexSessionMeta,
  object,
  string,
  timestamp,
} from "@ace/native-session";
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
  firstPrompt?: string,
): HistorySession {
  let nativeId = basename(path, ".jsonl");
  let cwd = "";
  let title = "";
  let prompt = firstPrompt ?? "";
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
        const spawned = object(object(meta.payload.source).subagent);
        parent =
          meta.payload.parent_thread_id ?? string(object(spawned.thread_spawn).parent_thread_id);
        if (
          Object.keys(spawned).length ||
          ["exec", "mcp"].includes(String(meta.payload.source)) ||
          Object.keys(object(object(meta.payload.source).internal)).length > 0 ||
          ["subagent", "guardian_review", "memory_consolidation"].includes(
            String(meta.payload.thread_source),
          )
        )
          parent ??= "non-interactive";
        if (
          (meta.payload.history_mode &&
            !["legacy", "paginated"].includes(meta.payload.history_mode)) ||
          meta.payload.history_base != null
        )
          reason =
            "This session refers to history in another file. Export it from Codex to open the complete conversation.";
      }
    } else if (instance.provider === "claude") {
      const meta = ClaudeSessionMeta.safeParse(r).data;
      if (meta) nativeId = meta.sessionId;
      if (r.isSidechain === true) parent ??= "sidechain";
    }
    if (instance.provider === "pi") {
      if (r.type === "session") {
        nativeId = string(r.id) ?? nativeId;
        if (![1, 2, 3].includes(Number(r.version ?? 1)))
          reason = "This Pi history format cannot be opened. Update ace and try again.";
      }
      if (r.type === "session_info") title = string(r.name) ?? title;
      if (r.type === "model_change") model = string(r.modelId) ?? model;
      if (r.type === "message" && ["user", "assistant"].includes(String(message.role))) count++;
    }
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
    if (firstPrompt === undefined) prompt ||= userPrompt(r);
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
    title: sessionTitle(title === nativeId ? "" : title, prompt, lastActivity),
    ...(model ? { model: model.slice(0, 512) } : {}),
    ...(parent ? { parentNativeId: parent } : {}),
    lastActivity,
    messageCount: count,
    countAccuracy: exact ? "exact" : "sampled",
    support: reason ? { status: "unsupported", reason } : { status: "supported" },
  });
}

export { userPrompt } from "./user-text.ts";
