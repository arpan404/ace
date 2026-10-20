import { rankFolders } from "@ace/project-picker";
import {
  displayPath,
  fuzzyPositions,
  parseFolderQuery,
  pathInput,
  type FolderQuery,
} from "@ace/ui-core";
import { useMemo } from "react";
import type { Machine } from "@/lib/machines.ts";
import { projectFailure, projectReads } from "./project-commands.ts";
import {
  useFolderListing,
  useFolderSearchQuery,
  useHostHome,
  useRecentFolders,
  type HostHome,
} from "./use-folders.ts";

/** One folder the list offers. */
export interface FolderRow {
  key: string;
  name: string;
  path: string;
  git: boolean;
  /** Already a project on its machine. */
  project: boolean;
  /** Matched letters in the name, for highlighting. */
  positions: readonly number[];
  /** Still showing from the previous query while this one is answered: not choosable. */
  stale?: boolean;
}

export interface FolderSection {
  id: "folders" | "children";
  label: string;
  rows: FolderRow[];
}

/** Where a row's typed letters fall in its name; none when only its path matched. */
function namePositions(query: string, name: string): number[] {
  return query ? (fuzzyPositions(query, name) ?? []) : [];
}

/**
 * Where a new project or clone goes on `machine`: the list under the location box. Empty: the
 * folders where browsing starts. Letters: the machine's folders as its daemon ranks them
 * (`fs.search`). A path: the folders inside it, narrowed by what follows the last slash; dot
 * folders show once that starts with a dot. Choosing a row only browses into it.
 */
export function useFolderSearch(options: { machine: Machine; text: string }) {
  const { machine, text } = options;
  const home: HostHome | undefined = useHostHome(machine).data;
  const query: FolderQuery = useMemo(
    () => parseFolderQuery(text, home?.path, home?.start),
    [text, home],
  );
  const only = useMemo(() => [machine], [machine]);
  const { isProject } = useRecentFolders(only);
  const words = query.kind === "search" ? query.text : "";
  const browsing = query.kind === "path" ? query.directory : words ? undefined : home?.start;
  const showHidden = query.kind === "path" && query.segment.startsWith(".");
  const listing = useFolderListing(machine, browsing, showHidden);
  const found = useFolderSearchQuery(machine, words, words !== "");

  const sections = useMemo((): FolderSection[] => {
    const row = (
      folder: { name: string; path: string; git?: boolean; project?: boolean },
      typed: string,
    ): FolderRow => ({
      key: folder.path,
      name: folder.name,
      path: folder.path,
      git: folder.git ?? false,
      project: folder.project ?? isProject(machine, folder.path),
      positions: namePositions(typed, folder.name),
    });
    const entries = listing.entries ?? [];
    if (query.kind === "path") {
      const byPath = new Map(entries.map((entry) => [entry.path, entry]));
      const inside = query.segment
        ? rankFolders(
            query.segment,
            entries.map((entry) => ({
              name: entry.name,
              path: entry.path,
              isGitRepo: entry.git,
              isProject: isProject(machine, entry.path),
              recentScore: 0,
            })),
            // Relative to the folder browsed, so its own path never matches the letters.
            [query.directory],
          ).flatMap((match) => {
            const entry = byPath.get(match.path);
            return entry ? [row(entry, query.segment)] : [];
          })
        : entries.map((entry) => row(entry, ""));
      return [
        { id: "children", label: `In ${displayPath(query.directory, home?.path)}`, rows: inside },
      ];
    }
    if (!words) {
      const start = home?.start;
      return [
        {
          id: "children",
          label: start ? `In ${displayPath(start, home?.path)}` : "Folders",
          rows: entries.map((entry) => row(entry, "")),
        },
      ];
    }
    const folders = (found.data?.entries ?? []).map((match) =>
      Object.assign(
        row(
          { name: match.name, path: match.path, git: match.isGitRepo, project: match.isProject },
          words,
        ),
        { stale: found.isPlaceholderData },
      ),
    );
    return [{ id: "folders", label: `Folders on ${machine.name}`, rows: folders }];
  }, [
    query,
    words,
    isProject,
    listing.entries,
    found.data,
    found.isPlaceholderData,
    machine,
    home,
  ]);

  const visible = sections.filter((section) => section.rows.length > 0);
  // A later page failing leaves the folders read so far; only a first read failing replaces them.
  const error =
    query.kind === "search" && words ? found.error : listing.restFailed ? null : listing.error;
  return {
    /** The machine these folders are on. */
    machineId: machine.id,
    client: machine.client,
    query,
    home,
    sections: visible,
    rows: visible.flatMap((section) => section.rows),
    /** The folder being browsed (path mode, or where browsing starts). */
    browsing,
    loading: listing.loading || (words !== "" && found.isFetching),
    /** The folder's later folders couldn't be read; `retry` reads them. */
    restFailed: browsing !== undefined && listing.restFailed,
    /** The folder has more folders than are read (5,000). */
    capped: browsing !== undefined && listing.capped,
    failure: error ? projectFailure(error) : undefined,
    offline: machine.client === undefined,
    /**
     * Tab in path mode, by the daemon (`fs.complete`): the box's text extended to what every
     * matching folder shares, or into the only one. Undefined when it can't grow.
     */
    complete: async (signal: AbortSignal): Promise<string | undefined> => {
      if (query.kind !== "path" || !machine.client) return undefined;
      const typed = pathInput(query.directory, home?.path) + query.segment;
      const reply = await projectReads(machine.client).complete(typed, showHidden, signal);
      const single = reply.candidates.length === 1 ? reply.candidates[0] : undefined;
      if (single && !reply.truncated) return single.completion;
      return reply.commonPrefix.length > typed.length ? reply.commonPrefix : undefined;
    },
    retry: () => {
      listing.retry();
      if (words) void found.refetch();
    },
  };
}

export type FolderSearch = ReturnType<typeof useFolderSearch>;
