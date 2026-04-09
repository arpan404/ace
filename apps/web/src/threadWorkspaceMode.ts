export type ThreadWorkspaceMode = "chat" | "editor" | "split";

export function normalizeThreadWorkspaceMode(value: unknown): ThreadWorkspaceMode {
  return value === "editor" || value === "split" ? value : "chat";
}
