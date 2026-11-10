import type { ProjectCommand } from "@ace/protocol";
import { makeFolders, planFolders } from "./project-folders.ts";
import {
  ProjectError,
  assertOrdinaryPath,
  canonicalProjectRoots,
  withoutProjectRoot,
} from "./project-policy.ts";

export interface ProjectRootsOptions {
  home: string;
  /** The configured `projects.roots`; empty allows home alone. */
  roots?: () => Promise<readonly string[]>;
  /** Replace the allowed project roots (`projects.roots`), already canonical. */
  saveRoots?: (roots: string[]) => Promise<void>;
}

type AddRoot = Extract<ProjectCommand, { type: "workspace.root.add" }>;
type RemoveRoot = Extract<ProjectCommand, { type: "workspace.root.remove" }>;

/**
 * Edits to the allowed project roots. Each reads the roots, awaits the filesystem, then saves a
 * new list, so they run one at a time (a whole `projects.roots` setting write takes the same
 * turn): an edit never saves over one that finished while it was waiting.
 */
export class ProjectRoots {
  private readonly options: ProjectRootsOptions;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(options: ProjectRootsOptions) {
    this.options = options;
  }
  /** Runs `edit` once every edit queued before it has settled. */
  exclusive<T>(edit: () => Promise<T>): Promise<T> {
    const run = this.tail.then(edit, edit);
    this.tail = run.catch(() => undefined);
    return run;
  }
  /**
   * Allow a folder as a project root, keeping home allowed when it is the first. With
   * `create`, a missing folder is made first and removed again if saving fails. `check` throws
   * when the caller may no longer change the roots.
   */
  add(p: AddRoot, check: () => void): Promise<{ ok: true }> {
    return this.exclusive(async () => {
      const save = this.saver();
      const plan = await planFolders(p.path);
      if (plan.missing.length && !p.create) throw new ProjectError("directory_missing");
      assertOrdinaryPath(plan.path);
      check();
      const made = plan.missing.length ? await makeFolders(plan) : undefined;
      try {
        const configured = (await this.options.roots?.()) ?? [];
        let roots: string[];
        try {
          roots = await canonicalProjectRoots([
            ...(configured.length ? configured : [this.options.home]),
            plan.path,
          ]);
        } catch (error) {
          throw error instanceof ProjectError ? error : new ProjectError("directory_unavailable");
        }
        check();
        await save(roots);
        return { ok: true as const };
      } catch (error) {
        made?.undo();
        throw error;
      } finally {
        await made?.close();
      }
    });
  }
  /**
   * Stop allowing one root, keeping the others as they are now; nothing is deleted. The last
   * root is refused (`last_root`): no roots at all would allow home again.
   */
  remove(p: RemoveRoot, check: () => void): Promise<{ ok: true }> {
    return this.exclusive(async () => {
      const save = this.saver();
      check();
      const roots = await withoutProjectRoot((await this.options.roots?.()) ?? [], p.path);
      if (!roots) return { ok: true as const };
      if (!roots.length) throw new ProjectError("last_root");
      check();
      await save(roots);
      return { ok: true as const };
    });
  }
  private saver() {
    const save = this.options.saveRoots;
    if (!save) throw new ProjectError("projects_unavailable");
    return save;
  }
}
