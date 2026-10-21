export type FileOperationDialog =
  | { kind: "create" | "mkdir"; folder: string }
  | { kind: "rename" | "move" | "delete"; path: string }
  | { kind: "archive"; path: string }
  | { kind: "trash" };

export { cleanPath, parentPath } from "@ace/ui-core";
