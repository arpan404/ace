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
  icon?: string | null;
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
  /** Still showing from the previous query while this one is answered: not choosable. */
  stale?: boolean;
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
      folder: {
        name: string;
        path: string;
        git?: boolean;
        project?: boolean;
        icon?: string | null;
      },
      on: Machine,
      typed: string,
    ): FolderRow => ({
      key: `${on.id}\u0000${folder.path}`,
      name: folder.name,
      path: folder.path,
      ...(folder.icon === undefined ? {} : { icon: folder.icon }),
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
      row(
        {
          name: folder.name,
          path: folder.path,
          project: true,
          ...(folder.icon === undefined ? {} : { icon: folder.icon }),
        },
        folder.machine,
        words,
      );
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
    // Projects on every machine, ranked together by name; each machine's own recency breaks
    // ties. A candidate's path is its name and then its place in `online`, written as a
    // private-use character no one types: it matches by what it's called, not where it lives,
    // in one pass with a single root.
    // Recents are capped at 100 per machine and 100 machines, well inside the plane.
    const keyOf = (index: number, name: string) =>
      `/${name}/${String.fromCodePoint(0xf0000 + index)}`;
    const indexOf = (path: string) => (path.codePointAt(path.lastIndexOf("/") + 1) ?? 0) - 0xf0000;
    const projects =
      mode === "open"
        ? rankFolders(
            words,
            online.map((folder, index) => ({
              name: folder.name,
              path: keyOf(index, folder.name),
              isGitRepo: false,
              isProject: true,
              recentScore: 1 / (folder.rank + 1),
            })),
            ["/"],
          )
            .slice(0, recentShown)
            .flatMap((match) => {
              const folder = online[indexOf(match.path)];
              return folder ? [asProject(folder)] : [];
            })
        : [];
    const listed = new Set(projects.map((each) => each.key));
    const folders = (found.data?.entries ?? [])
      .map((match) =>
        Object.assign(
          row(
            { name: match.name, path: match.path, git: match.isGitRepo, project: match.isProject },
            machine,
            words,
          ),
          { stale: found.isPlaceholderData },
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
    found.isPlaceholderData,
    machine,
    mode,
    home,
    several,
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
    /** Names in the folder being browsed, for name checks. */
    names: (listing.entries ?? []).map((entry) => entry.name),
    loading: listing.loading || (words !== "" && found.isFetching) || recent.loading,
    /** The folder's later folders couldn't be read; `retry` reads them. */
    restFailed: browsing !== undefined && listing.restFailed,
    /** The folder has more folders than are read (5,000). */
    capped: browsing !== undefined && listing.capped,
    /** More folders may match: the daemon stopped at its bounds. */
    truncated: words !== "" && (found.data?.truncated ?? false),
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
