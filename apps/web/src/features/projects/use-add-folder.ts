import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import type { Machine } from "@/lib/machines.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { newThreadIn, useLandInProject } from "./land.ts";
import { projectFailure, useProjectCommandsOn } from "./project-commands.ts";
import { useAllowFolder } from "./use-allow-folder.ts";
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
 * Adding a folder on `machine` from the palette. Either way the palette closes and a new thread
 * draft opens in the project on that machine. A folder that is already a project adds nothing,
 * with a toast saying so; otherwise the folder is added, or made and added (`create`). A refusal
 * stays as `problem`; one outside the allowed places can be allowed and added in one action,
 * whose toast's Undo stops allowing the folder (the project and its threads stay).
 */
export function useAddFolder(machine: Machine, close: () => void, initial?: AddProblem) {
  const commandsOn = useProjectCommandsOn();
  const land = useLandInProject();
  const navigate = useNavigate();
  const toast = useToast();
  const allowFolder = useAllowFolder();
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

  const run = async (path: string, how: "add" | "create"): Promise<void> => {
    if (pending.current) return;
    const known = existing(path);
    if (known) {
      close();
      toast.add({
        title: `${known.name} is already a project${machine.primary ? "" : ` on ${machine.name}`}`,
      });
      void navigate(newThreadIn(known.id, machine));
      return;
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
    } catch (error) {
      const failure = projectFailure(error);
      setProblem({
        path,
        message: failure.message,
        denied: failure.denied ?? false,
        canAllow: failure.canAllow ?? false,
      });
    } finally {
      pending.current = false;
      setAdding(false);
    }
  };

  /** Allow the folder, then add it; the toast's Undo stops allowing it. */
  const allowAndAdd = async (path: string) => {
    const client = machine.client;
    if (!client || pending.current) return;
    setAdding(true);
    try {
      await allowFolder(client, path);
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
    await run(path, "add");
  };

  return {
    adding,
    problem,
    add: (path: string) => void run(path, "add"),
    create: (path: string) => void run(path, "create"),
    allowAndAdd: (path: string) => void allowAndAdd(path),
  };
}
