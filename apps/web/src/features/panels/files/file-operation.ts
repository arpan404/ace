export type FileOperationDialog =
  | { kind: "create" | "mkdir"; folder: string }
  | { kind: "rename" | "move" | "delete"; path: string }
  | { kind: "archive"; path: string }
  | { kind: "trash" };

export const cleanPath = (path: string) => path.replace(/\/+$/, "");
export const parentPath = (path: string) => {
  const clean = cleanPath(path);
  const slash = clean.lastIndexOf("/");
  return slash < 0 ? "" : clean.slice(0, slash + 1);
};
