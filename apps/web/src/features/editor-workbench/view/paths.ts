/** The last segment of a checkout path: what a tab shows. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The folder part of a checkout path ("" at the checkout's root). */
export function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/**
 * The ways a folder can show in a narrow row, longest first: it gives way in its middle by whole
 * folders, keeping its first ones and its nearest one ("apps/web/…/workspace"), down to "…/" and
 * the nearest alone. A row shows the first that fits. Until #2519's `MiddleText`
 * (panels/files/middle-name.tsx) is on main; then Open editors should use it.
 */
export function folderVariants(folder: string): string[] {
  if (folder === "") return [];
  const parts = folder.split("/");
  const nearest = parts.at(-1) ?? folder;
  if (parts.length === 1) return [folder];
  const forms = [folder];
  for (let kept = parts.length - 2; kept >= 1; kept -= 1)
    forms.push(`${parts.slice(0, kept).join("/")}/…/${nearest}`);
  forms.push(`…/${nearest}`);
  return forms;
}
