import { PinnedDirectory } from "@ace/workspace";
import { join } from "node:path";
import { ProjectError, type ProjectPaths } from "./project-policy.ts";

/** Project policy owns paths; the shared workspace boundary owns descriptor acquisition. */
export class ProjectDirectory {
  readonly path: string;
  readonly handle: PinnedDirectory;
  private constructor(path: string, handle: PinnedDirectory) {
    this.path = path;
    this.handle = handle;
  }
  static async open(paths: ProjectPaths, input: string): Promise<ProjectDirectory> {
    const path = await paths.directory(input);
    try {
      return new ProjectDirectory(path, PinnedDirectory.open(path));
    } catch {
      throw new ProjectError("project_path_changed");
    }
  }
  async destination(name: string): Promise<ProjectDirectory> {
    let handle: PinnedDirectory;
    try {
      handle = this.handle.mkdir(name);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      try {
        handle = this.handle.child(name);
      } catch {
        throw new ProjectError("destination_not_directory");
      }
      try {
        if (!handle.empty()) throw new ProjectError("destination_not_empty");
      } catch (emptyError) {
        await handle.close();
        throw emptyError;
      }
    }
    return new ProjectDirectory(join(this.path, name), handle);
  }
  verify(): void {
    try {
      if (this.handle.matches(this.path)) return;
    } catch {
      /* Includes changed ancestors and links. */
    }
    throw new ProjectError("project_path_changed");
  }
  close(): Promise<void> {
    return this.handle.close();
  }
}
