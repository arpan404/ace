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
 * How much of a folder a narrow row keeps longest (`MiddleText`'s tail): its nearest folder with
 * the slash before it, so the start gives way first ("apps/w…/workspace", then "…/wor…").
 */
export function folderTail(folder: string): number {
  const at = folder.lastIndexOf("/");
  return at === -1 ? folder.length : folder.length - at;
}
