import { rankFolders } from "@ace/project-picker";
import { isPathInput, parseFolderQuery, pathRows, typedFolder, type PathRow } from "@ace/ui-core";
import { useMemo } from "react";
import type { Machine } from "@/lib/machines.ts";
import { projectFailure } from "./project-commands.ts";
import { useFolderListing, useHostHome, useRecentFolders } from "./use-folders.ts";
import { useNewFolder } from "./use-new-folder.ts";

/** A folder in the Local folder list. */
export interface LocalEntry {
  name: string;
  path: string;
  git: boolean;
  /** Already a project on this machine. */
  project: boolean;
}

export type LocalRow = PathRow<LocalEntry>;

const noSearch = { kind: "search", text: "" } as const;

/**
 * What the Local folder field shows on `machine` for `text`: a path (`~`, `/`, `./`; a bare name
 * is read inside where browsing starts) split into the folder browsed and what follows the last
 * slash, that folder's matching folders as rows (`..` first, creating the typed path last when
 * it's missing), and the typed folder when it exists.
 */
export function useLocalFolder(machine: Machine, text: string) {
  const home = useHostHome(machine).data;
  const only = useMemo(() => [machine], [machine]);
  const recent = useRecentFolders(only);
  const { isProject } = recent;
  const recentPaths = useMemo(() => recent.folders.map((folder) => folder.path), [recent.folders]);
  const query = useMemo(() => {
    const input = text === "" || isPathInput(text) ? text : `./${text}`;
    const parsed = parseFolderQuery(input, home?.path, home?.start);
    return parsed.kind === "path" ? parsed : undefined;
  }, [text, home]);
  const directory = query?.directory ?? (text === "" ? home?.start : undefined);
  const segment = query?.segment ?? "";
  const listing = useFolderListing(machine, directory, segment.startsWith("."));
  const missing = useNewFolder(machine, query ?? noSearch, home, recentPaths);
  const failure = listing.error ? projectFailure(listing.error) : undefined;
  // A folder that isn't there yet is something to create, not a failure.
  const refused = failure && !(missing && failure.code === "directory_unavailable");
  const entries = refused ? undefined : listing.entries;

  const rows = useMemo((): LocalRow[] => {
    if (directory === undefined) return [];
    const all = (entries ?? []).map((entry): LocalEntry => ({
      name: entry.name,
      path: entry.path,
      git: entry.git,
      project: isProject(machine, entry.path),
    }));
    const byPath = new Map(all.map((entry) => [entry.path, entry]));
    const matches = segment
      ? rankFolders(
          segment,
          all.map((entry) => ({
            name: entry.name,
            path: entry.path,
            isGitRepo: entry.git,
            isProject: entry.project,
            recentScore: 0,
          })),
          // Relative to the folder browsed, so its own path never matches the letters.
          [directory],
        ).flatMap((match) => byPath.get(match.path) ?? [])
      : all;
    return pathRows({ directory, segment, matches, missing });
  }, [directory, segment, entries, isProject, machine, missing]);

  return {
    home,
    recentPaths,
    /** The folder browsed. */
    directory,
    segment,
    rows,
    /** The folder the field names, when it exists. */
    typed:
      query && !listing.loading
        ? typedFolder({ directory: query.directory, segment, entries })
        : undefined,
    loading: listing.loading || (home === undefined && machine.client !== undefined),
    /** Why the folder couldn't be listed (outside the allowed places, unreadable). */
    failure: refused ? failure : undefined,
    retry: listing.retry,
  };
}
