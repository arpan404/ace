import { parseCloneUrl } from "@ace/project-picker";
import { fakeSearch, fakeComplete } from "./project-picker.ts";
import {
  Project,
  ProjectCloneUrl,
  ProjectCommand,
  ProjectInspection,
  ProjectsResult,
  WorkspaceId,
  type CommandPayload,
  type CommandResult,
  type ProjectsRequest,
  type WorkspaceChanged,
  WorkspaceCloneProgress,
} from "@ace/protocol";
import type { FakeServiceContext } from "./service-context.ts";

type Directory = {
  favicon?: string;
  empty: boolean;
  git: boolean;
  modifiedAt: number;
  initialBranch: string;
  remote?: string;
};
/** A folder on the fake host, for `seedFolders`. */
export interface FolderSeed {
  path: string;
  favicon?: string;
  /** A repository root (a `.git` inside). */
  git?: boolean;
  modifiedAt?: number;
}
/** Host filesystem fixture and registered catalog, including projects without threads. */
export class FakeProjects {
  private context: FakeServiceContext;
  private hasOwnedWork: (id: string) => boolean;
  private projects = new Map<string, Project>();
  private nextProject = 0;
  private opened = new Map<string, number>();
  /** The host user's home, canonical; the only allowed root unless `seedFolders` names others. */
  private home = "/fake";
  /** Allowed roots, canonical, as a real daemon reports them. */
  private roots: string[] = ["/fake"];
  /** The home folder as the host names it, when that is a symlink to `home`. */
  private homeLink: string | undefined;
  private removed = new Set<string>();
  private retained = new Map<string, Project>();
  private directories = new Map<string, Directory>([
    ["/fake", { empty: true, git: false, modifiedAt: 1, initialBranch: "main" }],
  ]);
  private listeners = new Set<(message: WorkspaceChanged | WorkspaceCloneProgress) => void>();
  /** Folder reads held until released, or refused with a code (test fault injection). */
  private readFaults: {
    match: (operation: ProjectsRequest["operation"]) => boolean;
    code?: string;
    held?: Promise<void>;
  }[] = [];
  private destinations = new Set<string>();
  private clones = new Map<
    string,
    {
      cancelled: boolean;
      committed: boolean;
      device: string;
      finished: Promise<void>;
      wake: (() => void) | undefined;
    }
  >();
  constructor(context: FakeServiceContext, hasOwnedWork: (id: string) => boolean) {
    this.context = context;
    this.hasOwnedWork = hasOwnedWork;
  }
  subscribe(listener: (message: WorkspaceChanged | WorkspaceCloneProgress) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(message: WorkspaceChanged | WorkspaceCloneProgress): void {
    for (const listener of this.listeners) listener(message);
  }
  private seed(): void {
    for (const thread of this.context.threads()) {
      const id = thread.workspaceId;
      if (this.projects.has(id) || this.removed.has(id)) continue;
      const project = Project.parse(
        thread.details?.workspace ?? { id, name: id, path: `/fake/${id}` },
      );
      this.projects.set(id, project);
      this.directories.set(project.path, {
        empty: false,
        git: true,
        modifiedAt: thread.createdAt,
        initialBranch: thread.details?.baseBranch ?? "main",
      });
    }
  }
  /**
   * A host filesystem for the folder browser: `home` becomes the home and only allowed root,
   * and each folder is created with its parents. Seeded projects outside it stay listed but
   * can't be browsed, like a project outside a real daemon's roots. `roots` replaces the allowed
   * roots (canonical paths); `homeLink` is a symlink to `home` the host reports as its home,
   * which the daemon resolves before checking roots.
   */
  seedFolders(
    home: string,
    folders: readonly FolderSeed[],
    options: { roots?: readonly string[]; homeLink?: string } = {},
  ): void {
    const root = home.replace(/\/+$/, "") || "/";
    this.home = root;
    this.roots = options.roots ? [...options.roots] : [root];
    this.homeLink = options.homeLink;
    const ensure = (path: string, value?: Partial<Directory>) => {
      const existing = this.directories.get(path);
      this.directories.set(path, {
        empty: false,
        git: false,
        modifiedAt: this.context.now(),
        initialBranch: "main",
        ...existing,
        ...value,
      });
    };
    for (const top of new Set([root, ...this.roots])) ensure(top);
    for (const folder of folders) {
      const top = [root, ...this.roots].find((entry) => folder.path.startsWith(`${entry}/`));
      if (top === undefined) continue;
      const relative = folder.path
        .slice(top.length + 1)
        .split("/")
        .filter(Boolean);
      if (relative.includes("..")) continue;
      for (let depth = 1; depth < relative.length; depth++)
        ensure(`${top}/${relative.slice(0, depth).join("/")}`);
      ensure(folder.path, {
        git: folder.git ?? false,
        ...(folder.favicon === undefined ? {} : { favicon: folder.favicon }),
        ...(folder.modifiedAt === undefined ? {} : { modifiedAt: folder.modifiedAt }),
      });
    }
  }
  get(id: string): Project | undefined {
    this.seed();
    return this.projects.get(id);
  }
  isRemoved(id: string): boolean {
    return this.removed.has(id);
  }
  cloneOwner(id: string): string | undefined {
    return this.clones.get(id)?.device;
  }
  list(after = "", limit = 50) {
    this.seed();
    const projects = [...this.projects.values()]
      .filter((p) => p.id > after)
      .toSorted((a, b) => (a.id < b.id ? -1 : 1));
    return {
      kind: "workspaces" as const,
      workspaces: projects.slice(0, limit),
      ...(projects.length > limit ? { next: projects[limit - 1]?.id } : {}),
    };
  }
  private allowedRoots(): readonly string[] {
    const configured = this.context.projectRoots?.();
    return configured?.length ? configured : this.roots;
  }
  private checked(path: string): string {
    if (!path.startsWith("/") || path.split("/").includes("..") || path.includes("\0"))
      throw new Error("invalid_path");
    const link = this.homeLink;
    const canonical =
      link && (path === link || path.startsWith(`${link}/`))
        ? this.home + path.slice(link.length)
        : path;
    if (!this.allowedRoots().some((root) => canonical === root || canonical.startsWith(`${root}/`)))
      throw new Error("outside_project_roots");
    return canonical.replace(/\/+$/, "") || "/";
  }
  private inspection(path: string) {
    this.seed();
    const selected = this.checked(path);
    if (!this.directories.has(selected)) throw new Error("directory_unavailable");
    const root = [...this.directories]
      .filter(
        ([entry, value]) => value.git && (selected === entry || selected.startsWith(`${entry}/`)),
      )
      .toSorted(([a], [b]) => b.length - a.length)[0];
    return ProjectInspection.parse({
      path: selected,
      defaultIcon: this.directories.get(selected)?.favicon,
      git: root
        ? {
            root: root[0],
            branch: root[1].initialBranch,
            defaultBranch: root[1].initialBranch,
            remotes: root[1].remote
              ? [{ name: "origin", fetchUrls: [root[1].remote], pushUrls: [] }]
              : [],
          }
        : null,
      ...(root && root[0] !== selected ? { suggestedRepoRoot: root[0] } : {}),
    });
  }
  private allocateId(): WorkspaceId {
    for (;;) {
      const id = WorkspaceId.parse(`project-${++this.nextProject}`);
      if (!this.projects.has(id) && !this.retained.has(id)) return id;
    }
  }
  private register(path: string, name: string, icon?: string | null) {
    const existing = [...this.projects.values(), ...this.retained.values()].find(
      (p) => p.path === path,
    );
    const id = existing?.id ?? this.allocateId();
    const project = Project.parse({
      ...(existing ?? { id, name, path }),
      ...(icon === undefined ? {} : { icon }),
      defaultIcon: this.directories.get(path)?.favicon,
    });
    const added = !this.projects.has(id);
    this.projects.delete(id);
    this.projects.set(id, project);
    this.opened.set(path, this.context.now());
    this.removed.delete(id);
    if (added || icon !== undefined)
      this.emit({
        type: "workspace.changed",
        workspaceId: id,
        change: added ? "added" : "updated",
        workspace: project,
      });
    return { ok: true, workspace: project, inspection: this.inspection(path) };
  }
  command(input: CommandPayload): Omit<CommandResult, "commandId"> | undefined {
    const decoded = ProjectCommand.safeParse(input);
    if (!decoded.success || decoded.data.type === "workspace.clone") return undefined;
    const p = decoded.data;
    this.seed();
    try {
      if (p.type === "workspace.add") {
        const info = this.inspection(p.path);
        return this.register(info.path, p.name ?? info.path.split("/").at(-1) ?? "Project", p.icon);
      }
      if (p.type === "workspace.create") {
        const parent = this.checked(p.parent);
        if (!this.directories.has(parent)) throw new Error("directory_unavailable");
        const path = `${parent}/${p.name}`;
        if (this.destinations.has(path)) throw new Error("project_busy");
        if (this.directories.get(path)?.empty === false) throw new Error("destination_not_empty");
        const parentDirectory = this.directories.get(parent);
        if (parentDirectory) parentDirectory.empty = false;
        this.directories.set(path, {
          empty: p.git === undefined && p.gitignore === undefined,
          git: p.git !== undefined,
          initialBranch: p.git?.initialBranch ?? "main",
          modifiedAt: this.context.now(),
        });
        return this.register(path, p.name, p.icon);
      }
      const project = this.projects.get(p.workspaceId);
      if (!project) throw new Error("workspace_not_found");
      const threads = this.context
        .threads()
        .filter((t) => t.workspaceId === project.id && t.deletedAt === undefined);
      if (p.type === "workspace.rename" || p.type === "workspace.update") {
        const icon = p.type === "workspace.update" ? p.icon : undefined;
        const workspace = { ...project, name: p.name, ...(icon === undefined ? {} : { icon }) };
        this.projects.set(project.id, workspace);
        for (const thread of threads)
          if (thread.details?.workspace)
            this.context.update(thread.id, {
              type: "thread.client.updated",
              changes: {
                details: {
                  ...thread.details,
                  workspace: {
                    ...thread.details.workspace,
                    name: p.name,
                    ...(icon === undefined ? {} : { icon }),
                    defaultIcon: workspace.defaultIcon,
                  },
                },
              },
            });
        this.emit({
          type: "workspace.changed",
          workspaceId: project.id,
          change: p.type === "workspace.rename" ? "renamed" : "updated",
          workspace,
        });
        return { ok: true, workspace };
      }
      if (
        !p.archiveThreads &&
        threads.some(
          (t) => !["new", "done", "failed"].includes(t.status.state) || this.hasOwnedWork(t.id),
        )
      )
        throw new Error("workspace_threads_running");
      if (p.archiveThreads)
        for (const thread of threads)
          if (thread.archivedAt === undefined)
            this.context.update(thread.id, {
              type: "thread.updated",
              archivedAt: this.context.now(),
            });
      this.projects.delete(project.id);
      this.retained.set(project.id, project);
      this.removed.add(project.id);
      this.emit({ type: "workspace.changed", workspaceId: project.id, change: "removed" });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "project_failed" };
    }
  }
  async clone(
    input: Extract<CommandPayload, { type: "workspace.clone" }>,
    commandId: string,
    device: string,
  ): Promise<Omit<CommandResult, "commandId">> {
    this.seed();
    const finished = Promise.withResolvers<void>();
    const flight: {
      cancelled: boolean;
      committed: boolean;
      device: string;
      finished: Promise<void>;
      wake: (() => void) | undefined;
    } = { cancelled: false, committed: false, device, finished: finished.promise, wake: undefined };
    this.clones.set(commandId, flight);
    const progress = (phase: WorkspaceCloneProgress["phase"], percent?: number) =>
      this.emit({
        type: "workspace.clone.progress",
        commandId: WorkspaceCloneProgress.shape.commandId.parse(commandId),
        phase,
        ...(percent === undefined ? {} : { percent }),
      });
    let destination: string | undefined;
    try {
      const parent = this.checked(input.parent);
      if (!this.directories.has(parent)) throw new Error("directory_unavailable");
      if (!ProjectCloneUrl.safeParse(input.url).success) throw new Error("git_invalid_argument");
      const parsedUrl = parseCloneUrl(input.url);
      const path = `${parent}/${input.name}`;
      if (this.directories.get(path)?.empty === false) throw new Error("destination_not_empty");
      if (this.destinations.has(path)) throw new Error("project_busy");
      this.destinations.add(path);
      destination = path;
      const parentDirectory = this.directories.get(parent);
      if (parentDirectory) parentDirectory.empty = false;
      this.directories.set(path, {
        empty: true,
        git: false,
        initialBranch: "main",
        modifiedAt: this.context.now(),
      });
      progress("starting");
      // Yield each stage to the transport so clients can send cancel before the receipt.
      // Receiving moves in steps, as Git reports it, so a progress bar has somewhere to go.
      const stages = [
        ["receiving", 30],
        ["receiving", 65],
        ["receiving", 100],
        ["resolving", 100],
        ["checkout", 100],
      ] as const;
      for (const [phase, percent] of stages) {
        await new Promise<void>((resolve) => {
          flight.wake = resolve;
          if (this.context.scheduleProject) this.context.scheduleProject(resolve);
          else queueMicrotask(resolve);
        });
        flight.wake = undefined;
        if (flight.cancelled) {
          progress("cancelled");
          return { ok: false, error: "clone_cancelled" };
        }
        progress(phase, percent);
      }
      this.directories.set(path, {
        empty: false,
        git: true,
        initialBranch: "main",
        remote: parsedUrl.url,
        modifiedAt: this.context.now(),
      });
      flight.committed = true;
      const result = this.register(path, input.name, input.icon);
      progress("completed", 100);
      return result;
    } catch (error) {
      progress("failed");
      return { ok: false, error: error instanceof Error ? error.message : "project_failed" };
    } finally {
      if (destination) this.destinations.delete(destination);
      this.clones.delete(commandId);
      finished.resolve();
    }
  }
  /**
   * Hold the folder reads `match` picks until `release()`, so a reply can arrive after the
   * person has moved on (a slow search or completion). Returns the release.
   */
  holdReads(match: (operation: ProjectsRequest["operation"]) => boolean): () => void {
    const gate = Promise.withResolvers<void>();
    const fault = { match, held: gate.promise };
    this.readFaults.push(fault);
    return () => {
      this.readFaults = this.readFaults.filter((each) => each !== fault);
      gate.resolve();
    };
  }
  /** Refuse the folder reads `match` picks with `code` until the returned function is called. */
  refuseReads(code: string, match: (operation: ProjectsRequest["operation"]) => boolean) {
    const fault = { match, code };
    this.readFaults.push(fault);
    return () => {
      this.readFaults = this.readFaults.filter((each) => each !== fault);
    };
  }
  async read(request: ProjectsRequest, device: string): Promise<ProjectsResult> {
    this.seed();
    const wrap = (result: ProjectsResult["result"]) =>
      ProjectsResult.parse({ type: "projects.result", requestId: request.requestId, result });
    const op = request.operation;
    for (const fault of this.readFaults.filter((each) => each.match(op))) {
      if (fault.held) await fault.held;
      if (fault.code) return wrap({ kind: "error", code: fault.code });
    }
    this.seed();
    try {
      if (op.op === "workspace.clone.validate") {
        try {
          return wrap({ kind: "cloneUrl", ...parseCloneUrl(op.url) });
        } catch {
          throw new Error("git_invalid_argument");
        }
      }
      if (op.op === "fs.search" || op.op === "fs.complete") {
        const recent = [...this.projects.values()].toReversed();
        const folders = [...this.directories].flatMap(([path, directory]) => {
          try {
            this.checked(path);
          } catch {
            return [];
          }
          const rank = recent.findIndex((project) => project.path === path);
          const lastOpened = rank < 0 ? undefined : this.opened.get(path);
          return [
            {
              name: path.split("/").at(-1) ?? path,
              path,
              isGitRepo: directory.git,
              isProject: rank >= 0,
              recentScore: rank < 0 || rank >= 100 ? 0 : 1 / (rank + 1),
              ...(lastOpened === undefined ? {} : { lastOpened }),
            },
          ];
        });
        return wrap(
          op.op === "fs.search"
            ? fakeSearch(op, folders, this.roots)
            : fakeComplete(
                op,
                folders,
                this.homeLink ?? this.home,
                (path) => this.checked(path),
                this.roots,
              ),
        );
      }
      if (op.op === "workspace.clone.cancel") {
        const flight = this.clones.get(op.commandId);
        if (!flight) throw new Error("clone_not_running");
        if (flight.device !== device) throw new Error("forbidden");
        if (flight.committed) throw new Error("clone_not_running");
        flight.cancelled = true;
        flight.wake?.();
        await flight.finished;
        return wrap({ kind: "cancelled", commandId: op.commandId });
      }
      if (op.op === "workspace.inspect")
        return wrap({ kind: "inspection", ...this.inspection(op.path) });
      if (op.op === "fs.home")
        return wrap({
          kind: "home",
          path: this.homeLink ?? this.home,
          canonicalPath: this.home,
          roots: [...this.allowedRoots()],
          initialBranch: "main",
        });
      if (op.op === "fs.recentFolders")
        return wrap({
          kind: "recentFolders",
          folders: [...this.projects.values()]
            .filter((folder) => {
              try {
                this.checked(folder.path);
                return true;
              } catch {
                return false;
              }
            })
            .slice(-op.limit)
            .toReversed(),
        });
      const path = this.checked(op.path);
      if (!this.directories.has(path)) throw new Error("directory_unavailable");
      const entries = [...this.directories]
        .filter(
          ([entry]) => entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes("/"),
        )
        .map(([entry, value]) => ({
          name: entry.slice(path.length + 1),
          path: entry,
          git: value.git,
          modifiedAt: value.modifiedAt,
        }))
        .filter(
          (entry) =>
            entry.name > (op.after ?? "") && (op.showHidden || !entry.name.startsWith(".")),
        )
        .toSorted((a, b) => (a.name < b.name ? -1 : 1));
      return wrap({
        kind: "directories",
        path,
        entries: entries.slice(0, op.limit),
        ...(entries.length > op.limit ? { next: entries[op.limit - 1]?.name } : {}),
      });
    } catch (error) {
      return wrap({
        kind: "error",
        code: error instanceof Error ? error.message : "project_failed",
      });
    }
  }
  cancelDevice(device: string): void {
    for (const flight of this.clones.values())
      if (flight.device === device) {
        flight.cancelled = true;
        flight.wake?.();
      }
  }
}
