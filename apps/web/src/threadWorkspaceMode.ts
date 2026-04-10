import * as Schema from "effect/Schema";

export type ThreadWorkspaceMode = "chat" | "editor" | "split";
export type ThreadWorkspaceLayoutMode = Exclude<ThreadWorkspaceMode, "chat">;

export const THREAD_WORKSPACE_MODE_BY_THREAD_ID_STORAGE_KEY = "ace:workspace:mode-by-thread:v1";
export const THREAD_WORKSPACE_LAYOUT_BY_THREAD_ID_STORAGE_KEY = "ace:workspace:layout-by-thread:v1";

export const ThreadWorkspaceModeSchema = Schema.Literals(["chat", "editor", "split"]);
export const ThreadWorkspaceLayoutModeSchema = Schema.Literals(["editor", "split"]);
export const ThreadWorkspaceModeByThreadIdSchema = Schema.Record(
  Schema.String,
  ThreadWorkspaceModeSchema,
);
export const ThreadWorkspaceLayoutByThreadIdSchema = Schema.Record(
  Schema.String,
  ThreadWorkspaceLayoutModeSchema,
);

export function normalizeThreadWorkspaceMode(value: unknown): ThreadWorkspaceMode {
  return value === "editor" || value === "split" ? value : "chat";
}

export function normalizeThreadWorkspaceLayoutMode(
  value: unknown,
  fallback: ThreadWorkspaceLayoutMode,
): ThreadWorkspaceLayoutMode {
  return value === "split" ? "split" : value === "editor" ? "editor" : fallback;
}
