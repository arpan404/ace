import type { ClientCore } from "@ace/client";
import { ProjectCommand, WorkspaceId } from "@ace/protocol";
import { submitCommand } from "./commands.ts";
import type { PatchSink, Preview } from "./agents.ts";

/*
 * What New thread finds on the computer before any thread exists: files to `@`-mention, through
 * a device-owned draft scope (`draft.create`, then `draft.mention.complete`, as the web's New
 * thread does), and folders to add as a project (`fs.recentFolders`, `fs.search`, then the
 * durable `workspace.add`). The draft scope is released when the sheet closes or the project
 * changes; the daemon also drops abandoned ones.
 */

export type ComposeSearchOwner = Pick<ClientCore, "request" | "enqueue" | "intent" | "commandId">;

const quiet = { timeoutMs: 15_000 };
/** Mention suggestions per query, as many as the web's own menu reads. */
export const mentionLimit = 20;

export class ComposeSearch {
  #owner: ComposeSearchOwner;
  #sink: PatchSink;
  #preview: Preview;
  #scope: { workspaceId: string; draftId: Promise<string> } | undefined;
  #query = 0;
  constructor(owner: ComposeSearchOwner, sink: PatchSink, preview: Preview) {
    this.#owner = owner;
    this.#sink = sink;
    this.#preview = preview;
  }

  /** Files in the project matching `query`, best first; only the latest query is answered. */
  async mentions(workspaceId: string, query: string): Promise<void> {
    const generation = ++this.#query;
    const put = (state: string, paths: string[]) =>
      this.#sink.put("compose:mentions", () => ({
        type: "compose.mentions",
        workspaceId,
        query,
        state,
        paths,
      }));
    put("loading", []);
    try {
      const draftId = await this.#draft(workspaceId);
      const reply = await this.#owner.request(
        {
          type: "context.request",
          operation: { op: "draft.mention.complete", draftId, query, limit: mentionLimit },
        },
        quiet,
      );
      if (generation !== this.#query) return;
      if (reply.result.kind !== "completion") throw new Error(reply.result.kind);
      put(
        "ready",
        reply.result.paths.slice(0, mentionLimit).map((path) => this.#preview(path, 1024)),
      );
    } catch {
      if (generation === this.#query) put("failed", []);
    }
  }

  /** Release the draft scope: the sheet closed or moved to another project. */
  release(): void {
    const scope = this.#scope;
    this.#scope = undefined;
    void scope?.draftId
      .then((draftId) =>
        this.#owner.request(
          { type: "context.request", operation: { op: "draft.release", draftId } },
          quiet,
        ),
      )
      .catch(() => {});
  }

  /** Folders on the computer to add: recent ones for an empty query, else a search. */
  async folders(query: string): Promise<void> {
    const put = (state: string, folders: Record<string, unknown>[]) =>
      this.#sink.put("compose:folders", () => ({
        type: "compose.folders",
        query,
        state,
        folders,
      }));
    put("loading", []);
    try {
      const trimmed = query.trim();
      const reply = await this.#owner.request(
        {
          type: "projects.request",
          operation: trimmed
            ? { op: "fs.search", query: trimmed.slice(0, 256), limit: 30 }
            : { op: "fs.recentFolders", limit: 20 },
        },
        quiet,
      );
      const result = reply.result;
      if (result.kind === "error") {
        put(result.code === "forbidden" ? "forbidden" : "failed", []);
        return;
      }
      const row = (name: string, path: string, project: boolean, git: boolean) => ({
        name: this.#preview(name, 256),
        path: this.#preview(path, 1024),
        project,
        git,
      });
      const rows =
        result.kind === "search"
          ? result.entries.map((entry) =>
              row(entry.name, entry.path, entry.isProject, entry.isGitRepo),
            )
          : result.kind === "recentFolders"
            ? result.folders.map((folder) => row(folder.name, folder.path, true, false))
            : [];
      put("ready", rows.slice(0, 30));
    } catch {
      put("failed", []);
    }
  }

  /** Register an existing folder as a project, through the durable outbox. */
  async addProject(path: string, requestId: string): Promise<void> {
    const admission = (ok: boolean, message: string) =>
      this.#sink.put(`admission:${requestId}`, () => ({
        type: "admission",
        id: requestId,
        ok,
        message,
      }));
    try {
      await submitCommand(
        this.#owner,
        ProjectCommand.parse({ type: "workspace.add", path }),
        () => admission(true, ""),
        (result) =>
          this.#sink.put(`compose:added:${requestId}`, () => ({
            type: "compose.added",
            id: requestId,
            ok: result.ok,
            projectId: result.workspace?.id ?? null,
            message: result.ok
              ? ""
              : this.#preview(result.error ?? "Couldn't add the folder", 2048),
          })),
      );
    } catch {
      admission(false, "Couldn't save the request on this phone.");
    }
  }

  #draft(workspaceId: string): Promise<string> {
    if (this.#scope?.workspaceId === workspaceId) return this.#scope.draftId;
    this.release();
    const draftId = this.#owner
      .request(
        {
          type: "context.request",
          operation: { op: "draft.create", workspaceId: WorkspaceId.parse(workspaceId) },
        },
        quiet,
      )
      .then((reply) => {
        if (reply.result.kind !== "draft") throw new Error(reply.result.kind);
        return reply.result.draftId;
      });
    const scope = { workspaceId, draftId };
    this.#scope = scope;
    // A scope that couldn't be made is asked for again next time.
    draftId.catch(() => {
      if (this.#scope === scope) this.#scope = undefined;
    });
    return draftId;
  }
}
