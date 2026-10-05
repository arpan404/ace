import { rankFolders } from "@ace/project-picker";
import {
  displayPath,
  folderName,
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
  type RecentFolder,
} from "./use-folders.ts";

/** One folder the list offers. */
export interface FolderRow {
  key: string;
  name: string;
  path: string;
  /** The machine it is on (a recent project can be on another one). */
  machine: Machine;
  git: boolean;
  /** Already a project on its machine. */
  project: boolean;
  /** The typed folder itself, in path mode. */
  self?: boolean;
  /** Matched letters in the name, for highlighting. */
  positions: readonly number[];
}

export interface FolderSection {
  id: "here" | "recent" | "projects" | "folders" | "children";
  label: string;
  rows: FolderRow[];
}

/**
 * `open` lists recent projects across machines too and offers a typed folder itself;
 * `location` only browses the chosen machine, for where a new project goes.
 */
export type SearchMode = "open" | "location";

const recentShown = 8;

/** Where a row's typed letters fall in its name; none when only its path matched. */
function namePositions(query: string, name: string): number[] {
  return query ? (fuzzyPositions(query, name) ?? []) : [];
}

/**
 * The list under the search box, in sections. Empty: recent projects on every machine, then the
 * folders where browsing starts. Letters: projects on every machine, then the chosen machine's
 * folders as its daemon ranks them (`fs.search`). A path: that folder itself, then the folders
 * inside it, narrowed by what follows the last slash; dot folders show once that starts with a
 * dot. Recent projects and a folder's insides are ranked with the daemon's own rules
 * (`@ace/project-picker`).
 */
export function useFolderSearch(options: {
  machine: Machine;
  machines: readonly Machine[];
  text: string;
  mode: SearchMode;
}) {
  const { machine, machines, text, mode } = options;
  const home: HostHome | undefined = useHostHome(machine).data;
  const query: FolderQuery = useMemo(
    () => parseFolderQuery(text, home?.path, home?.start),
    [text, home],
  );
  const scope = useMemo(() => (mode === "open" ? machines : [machine]), [mode, machines, machine]);
  const recent = useRecentFolders(scope);
  const words = query.kind === "search" ? query.text : "";
  const browsing = query.kind === "path" ? query.directory : words ? undefined : home?.start;
  const showHidden = query.kind === "path" && query.segment.startsWith(".");
  const listing = useFolderListing(machine, browsing, showHidden);
  const found = useFolderSearchQuery(machine, words, words !== "");
  const several = machines.length > 1;
  const { folders: recentFolders, isProject } = recent;

  const sections = useMemo((): FolderSection[] => {
    const row = (
      folder: { name: string; path: string; git?: boolean; project?: boolean },
      on: Machine,
      typed: string,
    ): FolderRow => ({
      key: `${on.id}\u0000${folder.path}`,
      name: folder.name,
      path: folder.path,
      machine: on,
      git: folder.git ?? false,
      project: folder.project ?? isProject(on, folder.path),
      positions: namePositions(typed, folder.name),
    });
    const entries = listing.entries ?? [];
    if (query.kind === "path") {
      const here: FolderSection[] =
        mode === "open" && !query.segment && listing.entries
          ? [
              {
                id: "here",
                label: "This folder",
                rows: [
                  Object.assign(
                    row({ name: folderName(query.directory), path: query.directory }, machine, ""),
                    { self: true },
                  ),
                ],
              },
            ]
          : [];
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
            return entry ? [row(entry, machine, query.segment)] : [];
          })
        : entries.map((entry) => row(entry, machine, ""));
      return [
        ...here,
        { id: "children", label: `In ${displayPath(query.directory, home?.path)}`, rows: inside },
      ];
    }
    const online = recentFolders.filter((folder) => folder.machine.client !== undefined);
    const asProject = (folder: RecentFolder) =>
      row({ name: folder.name, path: folder.path, project: true }, folder.machine, words);
    if (!words) {
      const start = home?.start;
      return [
        {
          id: "recent",
          label: "Recent",
          rows: mode === "open" ? online.slice(0, recentShown).map(asProject) : [],
        },
        {
          id: "children",
          label: start ? `In ${displayPath(start, home?.path)}` : "Folders",
          rows: entries.map((entry) => row(entry, machine, "")),
        },
      ];
    }
    // Projects on every machine, ranked together; each machine's own recency breaks ties.
    const keyOf = (folder: RecentFolder) => `${folder.machine.id}\u0000${folder.path}`;
    const byKey = new Map(online.map((folder) => [keyOf(folder), folder]));
    const projects =
      mode === "open"
        ? rankFolders(
            words,
            online.map((folder) => ({
              name: folder.name,
              path: keyOf(folder),
              isGitRepo: false,
              isProject: true,
              recentScore: 1 / (folder.rank + 1),
            })),
            // Each relative to its parent: a project matches by name, not by where it lives.
            online.map((folder) => {
              const key = keyOf(folder);
              return key.slice(0, key.lastIndexOf("/"));
            }),
          )
            .slice(0, recentShown)
            .flatMap((match) => {
              const folder = byKey.get(match.path);
              return folder ? [asProject(folder)] : [];
            })
        : [];
    const listed = new Set(projects.map((each) => each.key));
    const folders = (found.data?.entries ?? [])
      .map((match) =>
        row(
          { name: match.name, path: match.path, git: match.isGitRepo, project: match.isProject },
          machine,
          words,
        ),
      )
      .filter((each) => !listed.has(each.key));
    return [
      { id: "projects", label: several ? "Projects on your machines" : "Projects", rows: projects },
      { id: "folders", label: `Folders on ${machine.name}`, rows: folders },
    ];
  }, [
    query,
    words,
    recentFolders,
    isProject,
    listing.entries,
    found.data,
    machine,
    mode,
    home,
    several,
  ]);

  const visible = sections.filter((section) => section.rows.length > 0);
  const error = query.kind === "search" && words ? found.error : listing.error;
  return {
    query,
    home,
    sections: visible,
    rows: visible.flatMap((section) => section.rows),
    /** The folder being browsed (path mode, or where browsing starts). */
    browsing,
    /** Names in the folder being browsed, for name checks. */
    names: (listing.entries ?? []).map((entry) => entry.name),
    loading: listing.loading || (words !== "" && found.isFetching) || recent.loading,
    /** More folders may match: the daemon stopped at its bounds. */
    truncated: words !== "" && (found.data?.truncated ?? false),
    failure: error ? projectFailure(error) : undefined,
    offline: machine.client === undefined,
    /**
     * Tab in path mode, by the daemon (`fs.complete`): the box's text extended to what every
     * matching folder shares, or into the only one. Undefined when it can't grow.
     */
    complete: async (): Promise<string | undefined> => {
      if (query.kind !== "path" || !machine.client) return undefined;
      const typed = pathInput(query.directory, home?.path) + query.segment;
      const reply = await projectReads(machine.client).complete(typed, showHidden);
      const only = reply.candidates.length === 1 ? reply.candidates[0] : undefined;
      if (only && !reply.truncated) return only.completion;
      return reply.commonPrefix.length > typed.length ? reply.commonPrefix : undefined;
    },
    retry: () => {
      listing.retry();
      if (words) void found.refetch();
    },
  };
}

export type FolderSearch = ReturnType<typeof useFolderSearch>;
