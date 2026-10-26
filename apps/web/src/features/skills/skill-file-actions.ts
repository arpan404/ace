import { useClient } from "@ace/client-react";
import type { SkillEntry } from "@ace/protocol";
import { launchEditor } from "@/boot/editor-launch.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useEditors } from "@/lib/editors.ts";
import { useLocalReveal } from "@/lib/local-reveal.ts";
import { resolveRootPath } from "@/lib/project-roots.ts";
import { useSkillLibrary } from "./skills-library.tsx";

/**
 * Open a skill's SKILL.md in the person's editor, or show its folder in Finder (the desktop
 * app with a daemon on this computer). Each is undefined where it can't work: no editor on the
 * daemon's machine, a built-in skill with no folder of its own, or a browser.
 */
export function useSkillFileActions(entry: SkillEntry) {
  const client = useClient();
  const toast = useToast();
  const { current: editor } = useEditors();
  const project = useSkillLibrary().project;
  const reveal = useLocalReveal();
  // Display paths are `~/…` for personal skills and project-relative for the project's.
  const folder = async () =>
    entry.scope === "project"
      ? `${project?.path.replace(/\/+$/, "") ?? ""}/${entry.path}`
      : resolveRootPath(client, entry.path);
  const reachable = entry.scope !== "builtin" && (entry.scope !== "project" || !!project);
  return {
    open:
      reachable && editor
        ? async () => {
            try {
              await launchEditor({
                editorId: editor.id,
                editorName: editor.name,
                path: `${await folder()}/SKILL.md`,
              });
            } catch {
              toast.error({
                title: "Couldn't open the editor",
                description: `Check that ${editor.name} is installed, then try again.`,
              });
            }
          }
        : undefined,
    reveal:
      reachable && reveal
        ? async () => {
            try {
              await reveal(await folder());
            } catch {
              toast.error({ title: "Couldn't show the folder in Finder" });
            }
          }
        : undefined,
  };
}
