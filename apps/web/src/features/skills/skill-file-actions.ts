import { useClient } from "@ace/client-react";
import type { SkillEntry } from "@ace/protocol";
import { launchEditor } from "@/boot/editor-launch.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useEditors } from "@/lib/editors.ts";
import {
  skillHostFolderTarget,
  skillHostOpenTarget,
  useHostOpen,
  useRemoteHost,
} from "@/lib/host-open.ts";
import { useLocalReveal } from "@/lib/local-reveal.ts";
import { resolveRootPath } from "@/lib/project-roots.ts";
import { useSkillLibrary } from "./skills-library.tsx";

/**
 * Open a skill's SKILL.md in the person's editor, or show its folder in the file manager: the
 * desktop app with a local daemon opens here, another machine's daemon opens there (`host.open`,
 * toasting when only the owner can). A personal skill opens by its own host path; a builtin has
 * no folder of its own. Each is undefined where it can't work: no editor on the daemon's machine
 * or a browser that can't reach this computer's folders.
 */
export function useSkillFileActions(entry: SkillEntry) {
  const client = useClient();
  const toast = useToast();
  const { current: editor } = useEditors();
  const project = useSkillLibrary().project;
  const reveal = useLocalReveal();
  const remote = useRemoteHost();
  const host = useHostOpen();
  // Display paths are `~/…` for personal skills and project-relative for the project's.
  const folder = async () =>
    entry.scope === "project"
      ? `${project?.path.replace(/\/+$/, "") ?? ""}/${entry.path}`
      : resolveRootPath(client, entry.path);
  const target = skillHostOpenTarget(entry, project?.id);
  const folderTarget = skillHostFolderTarget(entry, project?.id);
  const reachable = entry.scope !== "builtin" && (entry.scope !== "project" || !!project);
  const remoteTarget = reachable && remote && target ? target : undefined;
  const remoteFolder = reachable && remote && folderTarget ? folderTarget : undefined;
  return {
    open:
      remoteTarget && editor
        ? () => void host.open(remoteTarget, editor.id)
        : reachable && !remote && editor
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
    reveal: remoteFolder
      ? () => void host.reveal(remoteFolder)
      : reachable && !remote && reveal
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
