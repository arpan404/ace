export type FileOperationDialog =
  | { kind: "create" | "mkdir"; folder: string }
  | { kind: "rename" | "move"; path: string }
  /** `paths`, when given, are every entry the delete covers (a selection); `path` is the first. */
  | { kind: "delete"; path: string; paths?: readonly string[] }
  | { kind: "archive"; path: string }
  | { kind: "trash" };

export { cleanPath, parentPath } from "@ace/ui-core";
