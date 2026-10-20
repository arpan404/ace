import { displayPath, folderName } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import type { Machine } from "@/lib/machines.ts";
import { addProjectRoot, saveProjectRoots } from "@/lib/project-roots.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { useLandInProject } from "./land.ts";
import { useOpenProject } from "./open-project.ts";
import { projectFailure, useProjectCommandsOn } from "./project-commands.ts";
import { useRecentFolders } from "./use-folders.ts";

export interface AddProblem {
  path: string;
  message: string;
  /** Outside the places the machine may open. */
  denied: boolean;
  /** One action allows the folder (and adds it). */
  canAllow: boolean;
}

const same = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/**
 * Adding a folder on `machine` from the palette. A folder that is already a project adds
 * nothing: its latest thread (or a new draft) opens, with a toast saying so. Otherwise the
 * folder is added, or made and added (`create`), the palette closes and a new thread draft
 * opens in it. A refusal stays as `problem`; one outside the allowed places can be allowed and
 * added in one action, undone from the toast.
 */
export function useAddFolder(machine: Machine, close: () => void, initial?: AddProblem) {
  const commandsOn = useProjectCommandsOn();
  const land = useLandInProject();
  const openProject = useOpenProject();
  const toast = useToast();
  const queries = useQueryClient();
  const directory = useProjectDirectory();
  const only = useMemo(() => [machine], [machine]);
  const recent = useRecentFolders(only).folders;
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<AddProblem | undefined>(initial);
  const pending = useRef(false);

  const existing = (path: string) =>
    machine.primary
      ? directory.projects.find((project) => same(project.path, path))
      : recent.find((folder) => same(folder.path, path));

  const run = async (path: string, how: "add" | "create"): Promise<string | undefined> => {
    if (pending.current) return undefined;
    const known = existing(path);
    if (known) {
      close();
      toast.add({
        title: `${known.name} is already a project${machine.primary ? "" : ` on ${machine.name}`}`,
      });
      if (machine.primary) openProject(known.id);
      return undefined;
    }
    pending.current = true;
    setAdding(true);
    setProblem(undefined);
    try {
      const commands = commandsOn(machine);
      const result =
        how === "create" ? await commands.createAndAdd(path) : await commands.add(path);
      close();
      land(result, how === "create" ? "Created" : "Added", { mode: "thread", machine });
      return result.project.id;
    } catch (error) {
      const failure = projectFailure(error);
      setProblem({
        path,
        message: failure.message,
        denied: failure.denied ?? false,
        canAllow: failure.canAllow ?? false,
      });
      return undefined;
    } finally {
      pending.current = false;
      setAdding(false);
    }
  };

  /** Allow the folder, then add it; the toast's Undo removes both. */
  const allowAndAdd = async (path: string, roots: readonly string[]) => {
    const client = machine.client;
    if (!client || pending.current) return;
    setAdding(true);
    try {
      await addProjectRoot(client, path);
    } catch {
      setAdding(false);
      setProblem({
        path,
        message: "Couldn't allow this folder. Check that it exists and is accessible.",
        denied: true,
        canAllow: false,
      });
      return;
    }
    await queries.invalidateQueries({ queryKey: ["projects", "folders"] });
    const added = await run(path, "add");
    const previous = [...roots];
    const toastId = toast.add({
      title: `Allowed ${displayPath(path, undefined)}`,
      actionProps: {
        children: "Undo",
        onClick: () => {
          toast.close(toastId);
          void (async () => {
            if (added) await commandsOn(machine).remove(added, false);
            await saveProjectRoots(client, previous);
            await queries.invalidateQueries({ queryKey: ["projects", "folders"] });
          })().catch(() =>
            toast.error({
              title: `Couldn't undo allowing ${folderName(path)}. Remove it in Settings.`,
            }),
          );
        },
      },
    });
  };

  return {
    adding,
    problem,
    add: (path: string) => void run(path, "add"),
    create: (path: string) => void run(path, "create"),
    allowAndAdd: (path: string, roots: readonly string[]) => void allowAndAdd(path, roots),
  };
}
