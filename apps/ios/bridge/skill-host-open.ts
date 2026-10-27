import type { SkillEntry, WorkspaceId } from "@ace/protocol";

/*
 * Open on computer, for a skill: its SKILL.md in an editor, or its folder in the file manager,
 * on the machine running ace (`workspace.request` `host.open`, see `host-open.ts`).
 *
 * A project skill's display path is relative to its project. A personal skill's is from `~`
 * (`~/.agents/skills/x`) or absolute, and the machine opens it by that path: personal skill
 * folders open for any phone that may operate, as projects do. A builtin skill sits in ace's
 * own install, which only the machine's owner opens. A plugin skill has no path of its own.
 */

/** Where Open on computer opens this skill, or null when it can't be opened there. */
export function hostOpenTarget(
  entry: Pick<SkillEntry, "scope" | "path">,
  workspaceId: WorkspaceId | undefined,
): { workspaceId: WorkspaceId; path: string } | { hostPath: string } | null {
  const file = `${entry.path.replace(/[\\/]+$/, "")}/SKILL.md`;
  if (entry.scope === "project") return workspaceId ? { workspaceId, path: file } : null;
  if (entry.scope === "plugin") return null;
  return hostPathLike(entry.path) ? { hostPath: file } : null;
}

/** Absolute (POSIX or a Windows drive) or from the home folder. */
function hostPathLike(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(path);
}
