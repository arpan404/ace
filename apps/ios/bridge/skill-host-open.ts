import type { SkillEntry } from "@ace/protocol";

/*
 * Open on computer, for a skill: its SKILL.md in an editor (or its folder in the file manager)
 * on the machine running ace.
 *
 * TODO(host.open): `workspace.request` `host.open` lands on branch
 * `ace/ios-gaps-projects-machines-notes` (commits 630f77f18, a348c13a5, 134eb5dc8), not yet on
 * main. It opens a path inside a project's or thread's folder:
 * `{ op: "host.open", app: { kind: "editor", editorId } | { kind: "files" }, workspaceId, path }`,
 * and that branch's `bridge/host-open.ts` and Swift `OpenOnHostMenu` drive it. Once it is
 * merged, return `{ workspaceId, path: `${entry.path}/SKILL.md` }` below for a project skill,
 * and the skill page shows Open on computer through `OpenOnHostMenu`. Personal skills
 * (`~/.agents/skills`) sit outside any project, so they need `host.open` to accept the skill
 * roots before they can open.
 */

/** Where Open on computer would open this skill, or null while `host.open` isn't available. */
export function hostOpenTarget(
  _entry: Pick<SkillEntry, "scope" | "path">,
  _workspaceId: string | undefined,
): { workspaceId: string; path: string } | null {
  return null;
}
