import {
  newFolder,
  newFolderBase,
  parentFolder,
  type FolderQuery,
  type NewFolder,
} from "@ace/ui-core";
import type { Machine } from "@/lib/machines.ts";
import { projectFailure } from "./project-commands.ts";
import { useFolderListing, type HostHome } from "./use-folders.ts";

/**
 * The folder the box's text would create on `machine`, while it doesn't exist yet. A path names
 * itself; a bare name goes beside the machine's most recent project, or where browsing starts
 * (`newFolderBase`). The folder it would go in is read to tell: when that is missing too, the
 * offer stands, since the daemon makes every missing folder on the way. Undefined while the
 * read is out, when the folder is already there, or when the daemon refuses that place.
 *
 * `recent` is the machine's project paths, most recently used first.
 */
export function useNewFolder(
  machine: Machine,
  query: FolderQuery,
  home: HostHome | undefined,
  recent: readonly string[],
): NewFolder | undefined {
  const folder = home ? newFolder(query, newFolderBase(recent, home.roots, home.start)) : undefined;
  // A path ending in "/" names the folder itself: it is missing when it can't be listed.
  const itself = query.kind === "path" && !query.segment;
  const place = folder && (itself ? folder.path : parentFolder(folder.path));
  const listing = useFolderListing(machine, place, folder?.name.startsWith(".") ?? false);
  if (!folder || listing.loading) return undefined;
  if (listing.error)
    return projectFailure(listing.error).code === "directory_unavailable" ? folder : undefined;
  if (itself || listing.entries === undefined) return undefined;
  // Names differing only in case are the same folder on the usual macOS and Windows disks.
  const name = folder.name.toLowerCase();
  const taken = listing.entries.some((entry) => entry.name.toLowerCase() === name);
  return taken ? undefined : folder;
}
