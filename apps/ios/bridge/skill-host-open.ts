import type { SkillEntry, WorkspaceId } from "@ace/protocol";

/*
 * Open on computer, for a skill: its SKILL.md in an editor, or its folder in the file manager,
 * on the machine running ace (`workspace.request` `host.open`, see `host-open.ts`).
 *
 * `host.open` opens paths inside a project's or thread's folder, so only project skills have a
 * target: their display path is relative to the project. Personal skills (`~/.agents/skills`)
 * sit outside every project; they wait on the owner deciding whether `host.open` may open the
 * agents' skill folders, and until then show no Open on computer.
 */

/** Where Open on computer opens this skill, or null when it can't be opened there. */
export function hostOpenTarget(
  entry: Pick<SkillEntry, "scope" | "path">,
  workspaceId: WorkspaceId | undefined,
): { workspaceId: WorkspaceId; path: string } | null {
  if (entry.scope !== "project" || !workspaceId) return null;
  return { workspaceId, path: `${entry.path.replace(/\/+$/, "")}/SKILL.md` };
}
