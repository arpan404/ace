/** A tree row as its actions see it: a checkout path without a trailing slash ("" is the root). */
export interface TreeEntry {
  path: string;
  folder: boolean;
}
