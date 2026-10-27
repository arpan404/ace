import type { PinnedDirectory } from "@ace/workspace";
import { basename, join } from "node:path";
import type { WorkspaceId } from "@ace/protocol";
import { folderIdentity, freeFolder, removeIfOwned } from "./files.ts";
import type { LandingDeps, TransferParent } from "./landing-types.ts";
import { TransferError } from "./ports.ts";

/**
 * What one landing made, undone when it fails. A reserved name is only a reservation: undo
 * removes a folder only once this landing made it and only while the name still leads to it.
 */
export class Made {
  private deps: LandingDeps;
  /** The new project's folder: its held parent, its name there, and once made its handle. */
  private folder:
    | { parent: TransferParent; name: string; handle?: PinnedDirectory; id?: string }
    | undefined;
  private registered: WorkspaceId | undefined;
  /** Past the cutoff: what was made is the result and stays. */
  kept = false;
  constructor(deps: LandingDeps) {
    this.deps = deps;
  }
  /** A free name for the new project in the held parent, recorded before anything is made. */
  async reserve(requested: string | undefined, name: string): Promise<TransferParent> {
    const parent = await this.deps.projects.parent(requested);
    try {
      const path = await freeFolder(parent.path, name, this.deps.held);
      this.deps.held.add(path);
      this.deps.made({ createdPath: path, createdId: undefined });
      this.folder = { parent, name: basename(path) };
      return parent;
    } catch (error) {
      await parent.close();
      throw error;
    }
  }
  private need() {
    if (!this.folder) throw new TransferError("import_failed", "No folder was reserved.");
    return this.folder;
  }
  get path(): string {
    const folder = this.need();
    return join(folder.parent.path, folder.name);
  }
  get name(): string {
    return this.need().name;
  }
  /** The folder this landing made, held open, once it is made. */
  get handle(): PinnedDirectory | undefined {
    return this.folder?.handle;
  }
  /**
   * Makes the reserved folder inside the held parent, without following links. A name someone
   * else took meanwhile fails here and stays theirs: nothing of it is ever removed.
   */
  mkdir(): PinnedDirectory {
    const folder = this.need();
    const handle = folder.parent.handle.mkdir(folder.name);
    // Swapped between making and opening: that folder isn't this landing's.
    if (!handle.empty()) {
      handle.closeSync();
      throw new TransferError(
        "import_failed",
        "The new project's folder changed while it was made.",
      );
    }
    folder.handle = handle;
    this.record(folder, folderIdentity(handle.stat()));
    return handle;
  }
  /** `workspace.clone` made the reserved folder: from here it is this landing's to remove. */
  cloning(directory: { dev: number; ino: number }): void {
    this.record(this.need(), folderIdentity(directory));
  }
  /** The folder `workspace.clone` made and filled, held open from here; never a swapped one. */
  cloned(): PinnedDirectory {
    const folder = this.need();
    const handle = folder.parent.handle.child(folder.name);
    if (folder.id !== folderIdentity(handle.stat())) {
      handle.closeSync();
      throw new TransferError(
        "import_failed",
        "The new project's folder changed while it was made.",
      );
    }
    folder.handle = handle;
    return handle;
  }
  private record(folder: NonNullable<Made["folder"]>, id: string): void {
    folder.id = id;
    this.deps.made({ createdPath: this.path, createdId: id });
  }
  registeredAs(workspaceId: WorkspaceId): void {
    this.registered = workspaceId;
    this.deps.made({ registeredId: workspaceId });
  }
  /** Removes only what this landing made; the record stays when a removal fails. */
  async undo(): Promise<void> {
    if (this.kept) return;
    if (this.registered)
      await this.deps.projects.unregister(this.registered).catch(() => undefined);
    const folder = this.folder;
    if (folder?.id) removeIfOwned(folder.parent, folder.name, folder.id);
    this.deps.made({ createdPath: undefined, createdId: undefined, registeredId: undefined });
  }
  async close(): Promise<void> {
    await this.folder?.handle?.close();
    await this.folder?.parent.close();
    this.folder = undefined;
  }
}
