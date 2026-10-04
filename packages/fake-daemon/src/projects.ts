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
  empty: boolean;
  git: boolean;
  modifiedAt: number;
  initialBranch: string;
  remote?: string;
};
/** Host filesystem fixture and registered catalog, including projects without threads. */
export class FakeProjects {
  private context: FakeServiceContext;
  private hasOwnedWork: (id: string) => boolean;
  private projects = new Map<string, Project>();
  private nextProject = 0;
  private removed = new Set<string>();
  private retained = new Map<string, Project>();
  private directories = new Map<string, Directory>([
    ["/fake", { empty: true, git: false, modifiedAt: 1, initialBranch: "main" }],
  ]);
  private listeners = new Set<(message: WorkspaceChanged | WorkspaceCloneProgress) => void>();
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
  private checked(path: string): string {
    if (!path.startsWith("/") || path.split("/").includes("..") || path.includes("\0"))
      throw new Error("invalid_path");
    if (path !== "/fake" && !path.startsWith("/fake/")) throw new Error("outside_project_roots");
    return path.replace(/\/+$/, "") || "/";
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
  private register(path: string, name: string) {
    const existing = [...this.projects.values(), ...this.retained.values()].find(
      (p) => p.path === path,
    );
    const id = existing?.id ?? this.allocateId();
    const project = existing ?? Project.parse({ id, name, path });
    const added = !this.projects.has(id);
    this.projects.delete(id);
    this.projects.set(id, project);
    this.removed.delete(id);
    if (added)
      this.emit({
        type: "workspace.changed",
        workspaceId: id,
        change: "added",
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
        return this.register(info.path, p.name ?? info.path.split("/").at(-1) ?? "Project");
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
        return this.register(path, p.name);
      }
      const project = this.projects.get(p.workspaceId);
      if (!project) throw new Error("workspace_not_found");
      const threads = this.context
        .threads()
        .filter((t) => t.workspaceId === project.id && t.deletedAt === undefined);
      if (p.type === "workspace.rename") {
        const workspace = { ...project, name: p.name };
        this.projects.set(project.id, workspace);
        for (const thread of threads)
          if (thread.details?.workspace)
            this.context.update(thread.id, {
              type: "thread.client.updated",
              changes: {
                details: {
                  ...thread.details,
                  workspace: { ...thread.details.workspace, name: p.name },
                },
              },
            });
        this.emit({
          type: "workspace.changed",
          workspaceId: project.id,
          change: "renamed",
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
      for (const phase of ["receiving", "resolving", "checkout"] as const) {
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
        progress(phase, 100);
      }
      this.directories.set(path, {
        empty: false,
        git: true,
        initialBranch: "main",
        remote: input.url,
        modifiedAt: this.context.now(),
      });
      flight.committed = true;
      const result = this.register(path, input.name);
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
  async read(request: ProjectsRequest, device: string): Promise<ProjectsResult> {
    this.seed();
    const wrap = (result: ProjectsResult["result"]) =>
      ProjectsResult.parse({ type: "projects.result", requestId: request.requestId, result });
    const op = request.operation;
    try {
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
        return wrap({ kind: "home", path: "/fake", roots: ["/fake"], initialBranch: "main" });
      if (op.op === "fs.recentFolders")
        return wrap({
          kind: "recentFolders",
          folders: [...this.projects.values()].slice(-op.limit).toReversed(),
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
