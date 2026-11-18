import type { WorkspaceFiles } from "./git-workspace.ts";

export const folderListingLimits = { entries: 200, bytes: 16 * 1024 };

/**
 * A folder mention names the folder and lists its non-ignored files with sizes, as ace-files
 * lists them. Agents read the files they need themselves, so no file contents are pasted here.
 * Work is bounded by the listing limits plus one pass over the folder to count it.
 */
export async function folderListing(
  workspace: WorkspaceFiles,
  folder: string,
  byteLimit: number,
): Promise<{ text: string; truncated: boolean }> {
  const lines: string[] = [];
  let total = 0,
    bytes = 0,
    full = false;
  const limit = Math.min(folderListingLimits.bytes, byteLimit);
  for await (const entry of workspace.list(folder)) {
    total++;
    if (full) continue;
    const line = entry.size === 0 ? entry.path : `${entry.path} (${entry.size} bytes)`;
    if (
      lines.length >= folderListingLimits.entries ||
      bytes + Buffer.byteLength(line) + 1 > limit - 256
    ) {
      full = true;
      continue;
    }
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
  }
  const name = folder === "." ? "./" : `${folder}/`;
  const header = `Folder: ${name} (${total} ${total === 1 ? "file" : "files"}; git-ignored files excluded). Contents are not inlined; read the files you need from the workspace.`;
  const more = total - lines.length;
  return {
    text: [header, ...lines, ...(more ? [`[ace: ${more} more files not listed]`] : [])].join("\n"),
    truncated: more > 0,
  };
}
