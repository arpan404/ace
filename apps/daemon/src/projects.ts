import { discoverProjectFavicon } from "./project-favicon.ts";
import { parseCloneUrl } from "@ace/project-picker";
import type { PickerFilesystem } from "./project-picker-filesystem.ts";
import { ProjectPicker } from "./project-picker.ts";
import { projectRemotes } from "./project-git.ts";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ProjectDirectory } from "./project-directory.ts";
import {
  GitService,
  GitError,
  validateCloneUrl,
  type GitOptions,
  type ProjectGitPolicy,
} from "@ace/git";
import {
  ProjectCommand,
  WorkspaceId,
  ProjectInspection,
  ProjectsRequest,
  type Command,
  type CommandResult,
  type ProjectsResult,
  type ThreadId,
  type WorkspaceChanged,
  type WorkspaceCloneProgress,
} from "@ace/protocol";
import { AsyncCommands } from "./async-commands.ts";
import { ProjectPaths, ProjectError, assertProjectPath } from "./project-policy.ts";
import { ProjectStorage } from "./project-storage.ts";
import { browseProjects } from "./project-browse.ts";
import type { Store } from "./store.ts";

export interface ProjectsOptions {
  home?: string;
  /** Monotonic clock at the filesystem I/O boundary, for scan budgets and cache expiry. */
  pickerClock?: () => number;
  pickerFilesystem?: PickerFilesystem;
  roots?: () => Promise<readonly string[]>;
  git?: GitOptions;
  /** Host-injected test fixture only; no client can set transport policy. */
  gitPolicy?: ProjectGitPolicy;
  hasOwnedWork?: (id: ThreadId) => boolean;
}
type CloneFlight = {
  committed: boolean;
  device: string;
  controller: AbortController;
  finished: Promise<CommandResult>;
};
export class Projects {
  readonly catalog: ProjectStorage;
  readonly ready: Promise<void>;
  private paths: ProjectPaths;
  private picker: ProjectPicker;
  private git: GitService;
  private store: Store;
  private options: ProjectsOptions;
  private home: string;
  private commands: AsyncCommands;
  private destinations = new Set<string>();
  private clones = new Map<string, CloneFlight>();
  private progressListeners = new Set<(device: string, progress: WorkspaceCloneProgress) => void>();
  private closed = false;
  private stopRevocation: () => void;
  constructor(store: Store, now: () => number, options: ProjectsOptions = {}) {
    this.store = store;
    this.options = options;
    this.home = options.home ?? homedir();
    this.paths = new ProjectPaths(this.home, options.roots ?? (async () => []));
    this.git = new GitService({ timeoutMs: 600_000, ...options.git });
    this.catalog = new ProjectStorage(store, now);
    this.picker = new ProjectPicker(
      this.paths,
      this.catalog,
      options.pickerClock ?? (() => performance.now()),
      options.pickerFilesystem,
    );
    this.commands = new AsyncCommands(store);
    this.stopRevocation = store.devices.onRevoke((device) => this.cancelDevice(device));
    this.ready = this.restoreIcons().catch(() => undefined);
  }
  /** Backfill persisted defaults once per daemon start; it never blocks service readiness. */
  private async restoreIcons(): Promise<void> {
    let after = "";
    while (!this.closed) {
      const rows = this.store
        .statement(
          "SELECT id,path FROM workspaces WHERE id>? AND NOT EXISTS(SELECT 1 FROM workspace_unregistered WHERE workspace_id=workspaces.id) ORDER BY id LIMIT 64",
        )
        .all(after);
      if (!rows.length) return;
      for (const row of rows) {
        if (this.closed) return;
        const id = WorkspaceId.parse(row.id);
        after = id;
        let directory: ProjectDirectory | undefined;
        try {
          directory = await ProjectDirectory.open(this.paths, String(row.path));
          const defaultIcon = await discoverProjectFavicon(directory.handle);
          if (this.closed) return;
          directory.verify();
          const project = this.catalog.get(id);
          if (
            defaultIcon !== undefined &&
            project.path === directory.path &&
            (project.defaultIcon ?? null) !== defaultIcon
          )
            this.catalog.update(id, project.name, undefined, "updated", defaultIcon);
        } catch {
          /* A missing favicon or changed project path never prevents daemon startup. */
        } finally {
          await directory?.close();
        }
      }
    }
  }
  private async favicon(path: string): Promise<string | null | undefined> {
    let directory: ProjectDirectory | undefined;
    try {
      directory = await ProjectDirectory.open(this.paths, path);
      const icon = await discoverProjectFavicon(directory.handle);
      directory.verify();
      return icon;
    } catch {
      return undefined;
    } finally {
      await directory?.close();
    }
  }
  subscribe(listener: (change: WorkspaceChanged) => void): () => void {
    return this.catalog.subscribe(listener);
  }
  onProgress(listener: (device: string, progress: WorkspaceCloneProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }
  private progress(device: string, value: WorkspaceCloneProgress): void {
    for (const listener of this.progressListeners) {
      try {
        listener(device, value);
      } catch {
        /* Consumers do not own Git lifetime. */
      }
    }
  }
  private check(allowed: () => boolean): void {
    if (this.closed) throw new ProjectError("projects_closed");
    if (!allowed()) throw new ProjectError("forbidden");
  }
  async inspect(input: string) {
    const directory = await ProjectDirectory.open(this.paths, input);
    try {
      return await this.inspectDirectory(directory);
    } finally {
      await directory.close();
    }
  }
  private async inspectDirectory(directory: ProjectDirectory, signal?: AbortSignal) {
    const path = directory.path;
    let git = null;
    try {
      const info = await this.git.projectInfo(path, directory.handle.fd, signal);
      // A repository above the selected allowed root cannot be offered to the client.
      const root = await this.paths.directory(info.root);
      git = {
        root,
        branch: info.branch,
        defaultBranch: await this.git.defaultBranch(path, directory.handle.fd, signal),
        remotes: projectRemotes(info.remotes),
      };
    } catch (error) {
      if (
        !(
          error instanceof ProjectError &&
          ["outside_project_roots", "system_directory"].includes(error.code)
        ) &&
        !(error instanceof GitError && error.code === "not_a_repo")
      )
        throw error;
    }
    const defaultIcon = await discoverProjectFavicon(directory.handle);
    directory.verify();
    return ProjectInspection.parse({
      path,
      ...(defaultIcon == null ? {} : { defaultIcon }),
      git,
      ...(git && git.root !== path ? { suggestedRepoRoot: git.root } : {}),
    });
  }
  execute(input: Command, allowed: () => boolean = () => true): Promise<CommandResult> {
    const existing = this.clones.get(input.id);
    if (existing)
      return existing.device === input.deviceId
        ? existing.finished
        : Promise.resolve({ commandId: input.id, ok: false, error: "forbidden" });
    const controller = new AbortController();
    const flight = this.commands.run(input, async () => {
      try {
        this.check(allowed);
        const p = ProjectCommand.parse(input.payload);
        if (p.type === "workspace.add") {
          const directory = await ProjectDirectory.open(this.paths, p.path);
          try {
            const inspection = await this.inspectDirectory(directory);
            assertProjectPath(directory.path, await this.paths.roots());
            this.check(allowed);
            this.store.workspaceReservations.assertAvailable(directory.path);
            if (this.destinations.has(directory.path)) throw new ProjectError("project_busy");
            directory.verify();
            const workspace = this.catalog.register(
              directory.path,
              p.name ?? basename(directory.path).slice(0, 256),
              p.icon,
              inspection.defaultIcon,
            );
            return { ok: true, workspace, inspection };
          } finally {
            await directory.close();
          }
        }
        if (
          p.type === "workspace.rename" ||
          p.type === "workspace.update" ||
          p.type === "workspace.remove"
        ) {
          const project = this.catalog.get(p.workspaceId);
          assertProjectPath(project.path, await this.paths.roots());
          this.check(allowed);
          if (p.type === "workspace.update") {
            const defaultIcon = await this.favicon(project.path);
            this.check(allowed);
            return {
              ok: true,
              workspace: this.catalog.update(p.workspaceId, p.name, p.icon, "updated", defaultIcon),
            };
          }
          if (p.type === "workspace.rename")
            return { ok: true, workspace: this.catalog.rename(p.workspaceId, p.name) };
          this.catalog.remove(
            p.workspaceId,
            p.archiveThreads,
            this.options.hasOwnedWork ?? (() => false),
          );
          return { ok: true };
        }
        const parentDirectory = await ProjectDirectory.open(this.paths, p.parent);
        const parent = parentDirectory.path;
        const path = join(parent, p.name);
        if (this.destinations.has(path)) {
          await parentDirectory.close();
          throw new ProjectError("project_busy");
        }
        this.destinations.add(path);
        let directory: ProjectDirectory | undefined;
        try {
          this.check(allowed);
          let cloneUrl: string | undefined;
          try {
            cloneUrl =
              p.type === "workspace.clone"
                ? this.options.gitPolicy?.validateUrl
                  ? p.url
                  : parseCloneUrl(p.url).url
                : undefined;
          } catch {
            throw new ProjectError("git_invalid_argument");
          }
          if (cloneUrl !== undefined)
            (this.options.gitPolicy?.validateUrl ?? validateCloneUrl)(cloneUrl);
          this.store.workspaceReservations.assertAvailable(path);
          directory = await parentDirectory.destination(p.name);
          this.check(allowed);
          if (p.type === "workspace.create") {
            if (p.git) await this.git.init(path, p.git.initialBranch, directory.handle.fd);
            if (p.gitignore !== undefined) {
              this.check(allowed);
              await directory.handle.writeExclusive(".gitignore", p.gitignore);
            }
          } else {
            controller.signal.throwIfAborted();
            this.progress(input.deviceId, {
              type: "workspace.clone.progress",
              commandId: input.id,
              phase: "starting",
            });
            await this.git.clone(
              {
                parent,
                path,
                url: cloneUrl ?? p.url,
                directoryFd: directory.handle.fd,
                signal: controller.signal,
                progress: (value) => {
                  if (!allowed()) controller.abort();
                  else
                    this.progress(input.deviceId, {
                      type: "workspace.clone.progress",
                      commandId: input.id,
                      ...value,
                    });
                },
              },
              this.options.gitPolicy,
            );
          }
          controller.signal.throwIfAborted();
          const inspection = await this.inspectDirectory(directory, controller.signal);
          if (p.type === "workspace.clone" && !inspection.git)
            throw new ProjectError("clone_not_repository");
          assertProjectPath(directory.path, await this.paths.roots());
          this.check(allowed);
          directory.verify();
          controller.signal.throwIfAborted();
          // Commit is synchronous. Cancellation may not contradict pushes emitted by registration.
          const clone = this.clones.get(input.id);
          if (clone) clone.committed = true;
          const workspace = this.catalog.register(
            directory.path,
            p.name,
            p.icon,
            inspection.defaultIcon,
          );
          if (p.type === "workspace.clone") {
            this.progress(input.deviceId, {
              type: "workspace.clone.progress",
              commandId: input.id,
              phase: "completed",
              percent: 100,
            });
          }
          return { ok: true, workspace, inspection };
        } finally {
          this.destinations.delete(path);
          await directory?.close();
          await parentDirectory.close();
        }
      } catch (error) {
        const cancelled = controller.signal.aborted;
        if (input.payload.type === "workspace.clone")
          this.progress(input.deviceId, {
            type: "workspace.clone.progress",
            commandId: input.id,
            phase: cancelled ? "cancelled" : "failed",
          });
        return { ok: false, error: cancelled ? "clone_cancelled" : projectErrorCode(error) };
      }
    });
    if (input.payload.type === "workspace.clone") {
      this.clones.set(input.id, {
        committed: false,
        device: input.deviceId,
        controller,
        finished: flight,
      });
      const forget = () => {
        this.clones.delete(input.id);
      };
      void flight.then(forget, forget);
    }
    return flight;
  }
  async read(
    input: ProjectsRequest,
    device: string,
    allowed: () => boolean = () => true,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProjectsResult> {
    const request = ProjectsRequest.parse(input);
    const wrap = (result: ProjectsResult["result"]): ProjectsResult => ({
      type: "projects.result",
      requestId: request.requestId,
      result,
    });
    try {
      this.check(allowed);
      const op = request.operation;
      let result: ProjectsResult["result"];
      if (op.op === "fs.search") result = await this.picker.search(op, signal, allowed);
      else if (op.op === "fs.complete")
        result = await this.picker.complete(op, this.home, signal, allowed);
      else if (op.op === "workspace.clone.validate") {
        try {
          result = { kind: "cloneUrl", ...parseCloneUrl(op.url) };
        } catch {
          throw new ProjectError("git_invalid_argument");
        }
      } else if (op.op === "workspace.clone.cancel") {
        const clone = this.clones.get(op.commandId);
        if (!clone) throw new ProjectError("clone_not_running");
        if (clone.device !== device) throw new ProjectError("forbidden");
        if (clone.committed) throw new ProjectError("clone_not_running");
        clone.controller.abort();
        await clone.finished;
        result = { kind: "cancelled", commandId: op.commandId };
      } else if (op.op === "workspace.inspect")
        result = { kind: "inspection", ...(await this.inspect(op.path)) };
      else if (op.op === "fs.home")
        result = {
          kind: "home",
          path: this.home,
          canonicalPath: await realpath(this.home),
          roots: await this.paths.roots(),
          initialBranch: await this.git.initialBranch(this.home),
        };
      else if (op.op === "fs.recentFolders") {
        const folders = [];
        for (const folder of this.catalog.recent(op.limit)) {
          try {
            await this.paths.directory(folder.path);
            folders.push(folder);
          } catch {
            /* Changed roots hide old registrations. */
          }
        }
        result = { kind: "recentFolders", folders };
      } else result = await browseProjects(this.paths, op);
      if (result.kind !== "home" && result.kind !== "cancelled" && result.kind !== "cloneUrl") {
        const roots = await this.paths.roots();
        if (result.kind === "recentFolders")
          for (const folder of result.folders) assertProjectPath(folder.path, roots);
        else if (result.kind === "search" || result.kind === "completion") {
          for (const entry of result.kind === "search" ? result.entries : result.candidates)
            assertProjectPath(entry.path, roots);
        } else {
          assertProjectPath(result.path, roots);
          if (result.kind === "directories")
            for (const entry of result.entries) assertProjectPath(entry.path, roots);
          else if (result.git) assertProjectPath(result.git.root, roots);
        }
      }
      this.check(allowed);
      if ((op.op === "fs.search" || op.op === "fs.complete") && signal.aborted)
        throw new ProjectError("search_cancelled");
      return wrap(result);
    } catch (error) {
      return wrap({ kind: "error", code: projectErrorCode(error) });
    }
  }
  cancelDevice(device: string): void {
    for (const clone of this.clones.values()) if (clone.device === device) clone.controller.abort();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.stopRevocation();
    for (const clone of this.clones.values()) clone.controller.abort();
    await Promise.all([this.git.close(), this.commands.drained(), this.ready]);
  }
}
export function projectErrorCode(error: unknown): string {
  return error instanceof ProjectError
    ? error.code
    : error instanceof GitError
      ? `git_${error.code.replace(/^git_/, "")}`
      : "project_failed";
}
