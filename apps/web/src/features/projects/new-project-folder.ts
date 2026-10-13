import { parseFolderQuery } from "@ace/ui-core";
import { useMemo } from "react";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { useProjectCommands } from "./project-commands.ts";
import { useHostHome, useRecentFolders } from "./use-folders.ts";
import { useNewFolder } from "./use-new-folder.ts";

/**
 * A project search read as a folder to create on this window's machine: the folder the typed
 * text would make (a path, `~` included, or a bare name beside the latest project) while it
 * doesn't exist, and the call that makes it there and adds it.
 */
export function useNewProjectFolder(text: string) {
  const machine = usePrimaryMachine();
  const home = useHostHome(machine).data;
  const scope = useMemo(() => [machine], [machine]);
  const recent = useRecentFolders(scope).folders;
  const paths = useMemo(() => recent.map((folder) => folder.path), [recent]);
  const query = useMemo(() => parseFolderQuery(text.trim(), home?.path, home?.start), [text, home]);
  const folder = useNewFolder(machine, query, home, paths);
  const commands = useProjectCommands(machine);
  return { folder, home: home?.path, create: commands.createAndAdd };
}
