import { useClient, useConnectionState } from "@ace/client-react";
import { WorkspaceId, type SkillEntry } from "@ace/protocol";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useProjectDirectory } from "@/lib/projects.ts";
import { watchLibrary } from "./library-source.ts";

interface Library {
  /** Every skill the person's agents read, merged across agents; undefined until read. */
  entries: readonly SkillEntry[] | undefined;
  failed: boolean;
  retry(): void;
  /** The project whose skills are listed, and the others the person can switch to. */
  project: { id: WorkspaceId; name: string; path: string } | undefined;
  projects: readonly { id: string; name: string }[];
  chooseProject(id: string): void;
}

const LibraryContext = createContext<Library>({
  entries: [],
  failed: false,
  retry: () => {},
  project: undefined,
  projects: [],
  chooseProject: () => {},
});
export const useSkillLibrary = () => useContext(LibraryContext);

/** Skills lists the daemon's merged library for one project at a time. */
export function SkillsLibraryProvider({ children }: { children: ReactNode }) {
  const client = useClient();
  const connection = useConnectionState();
  const directory = useProjectDirectory();
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState("");
  const chosen = directory.projects.find((p) => p.id === selected) ?? directory.projects[0];
  const parsed = chosen ? WorkspaceId.safeParse(chosen.id) : undefined;
  const project =
    chosen && parsed?.success ? { id: parsed.data, name: chosen.name, path: chosen.path } : undefined;
  const [snapshot, setSnapshot] = useState<{
    key: string;
    entries: readonly SkillEntry[];
    failed: boolean;
  }>();
  const workspaceId = project?.id;
  const key = `${workspaceId ?? ""}:${revision}`;
  const ready = connection === "ready" && directory.loaded;
  useEffect(() => {
    if (!ready) return;
    return watchLibrary(
      client,
      workspaceId,
      (entries) => setSnapshot({ key, entries, failed: false }),
      () => setSnapshot({ key, entries: [], failed: true }),
    );
  }, [client, ready, workspaceId, key]);
  // A project switch keeps the last list on screen until the new one arrives.
  const current = snapshot?.key === key ? snapshot : undefined;
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const projectName = project?.name;
  const projectPath = project?.path;
  const value = useMemo(
    () => ({
      entries: current && !current.failed ? current.entries : snapshot?.entries,
      failed: current?.failed ?? false,
      retry,
      project:
        workspaceId && projectName && projectPath !== undefined
          ? { id: workspaceId, name: projectName, path: projectPath }
          : undefined,
      projects: directory.projects,
      chooseProject: setSelected,
    }),
    [current, snapshot, retry, workspaceId, projectName, projectPath, directory.projects],
  );
  return <LibraryContext value={value}>{children}</LibraryContext>;
}
