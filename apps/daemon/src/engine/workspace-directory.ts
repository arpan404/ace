import { realpathSync, statSync } from "node:fs";
/** Filesystem boundary shared by preflight and receipt-time validation. */
export function workspaceDirectory(path: string): string {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error("workspace_unavailable");
  return canonical;
}
