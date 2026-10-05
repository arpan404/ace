import { z } from "zod";
import { ProjectDirectory } from "./project-directory.ts";
import type { ProjectPaths } from "./project-policy.ts";

/** Inject only the filesystem boundary; tests still use real pinned directories and sockets. */
export interface PickerFilesystem {
  open(paths: ProjectPaths, path: string): Promise<ProjectDirectory>;
  names(directory: ProjectDirectory): string[];
  metadata(directory: ProjectDirectory, name: string): { mode: number };
}
export const pickerFilesystem: PickerFilesystem = {
  open: (paths, path) => ProjectDirectory.open(paths, path),
  names: (directory) => directory.handle.names(),
  metadata: (directory, name) => directory.handle.metadata(name),
};
const EntryMetadata = z.object({ mode: z.number().int().nonnegative() });
const Names = z.array(z.string().max(256)).max(10_000);
export function pickerNames(filesystem: PickerFilesystem, directory: ProjectDirectory): string[] {
  return Names.parse(filesystem.names(directory));
}
export function pickerKind(
  filesystem: PickerFilesystem,
  directory: ProjectDirectory,
  name: string,
): number {
  return EntryMetadata.parse(filesystem.metadata(directory, name)).mode & 0o170000;
}
export function missingEntry(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))
  );
}
export function retryDirectory(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["EAGAIN", "EBUSY", "EINTR", "EMFILE", "ENFILE", "EIO", "EACCES"].includes(String(error.code))
  );
}
