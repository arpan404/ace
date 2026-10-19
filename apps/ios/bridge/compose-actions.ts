import type { ClientCore } from "@ace/client";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import { ComposeSearch } from "./compose-search.ts";
import { CreateAction, NewThread } from "./new-thread.ts";
import { ProjectFiles } from "./project-files.ts";

/*
 * The `compose` (New thread, Add project) and `files` (the Files sheet: a thread's checkout, or
 * from New thread a project's own folder) actions Swift sends, parsed once and routed to their
 * sessions. `false` means the action couldn't be read.
 */

const id = z.string().min(1).max(128);
const ComposeAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open") }),
  z.object({ kind: z.literal("close") }),
  z.object({ kind: z.literal("projects") }),
  z.object({ kind: z.literal("agents") }),
  z.object({ kind: z.literal("branches"), workspaceId: id }),
  z.object({ kind: z.literal("mentions"), workspaceId: id, query: z.string().max(128) }),
  z.object({ kind: z.literal("folders"), query: z.string().max(256) }),
  z.object({
    kind: z.literal("addProject"),
    path: z.string().min(1).max(4096),
    requestId: z.string().min(1).max(64),
  }),
  CreateAction,
]);
const FilesAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), threadId: id }),
  z.object({ kind: z.literal("openProject"), workspaceId: id }),
  z.object({ kind: z.literal("folder"), path: z.string().max(4096) }),
  z.object({ kind: z.literal("search"), query: z.string().max(128) }),
  z.object({ kind: z.literal("preview"), path: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal("close") }),
]);

export class ComposeActions {
  readonly newThread: NewThread;
  readonly search: ComposeSearch;
  readonly checkout: ProjectFiles;
  constructor(owner: ClientCore, sink: PatchSink, preview: Preview, now: () => number) {
    this.newThread = new NewThread(owner, sink, preview, now);
    this.search = new ComposeSearch(owner, sink, preview);
    this.checkout = new ProjectFiles(owner, sink, preview, (workspaceId, query, limit) =>
      this.search.complete(workspaceId, query, limit),
    );
  }
  compose(raw: unknown): boolean {
    const parsed = ComposeAction.safeParse(raw);
    if (!parsed.success) return false;
    const action = parsed.data;
    switch (action.kind) {
      case "open":
        this.newThread.open();
        break;
      case "close":
        this.search.release();
        break;
      case "projects":
        void this.newThread.projects();
        break;
      case "agents":
        void this.newThread.agents();
        break;
      case "branches":
        void this.newThread.branches(action.workspaceId);
        break;
      case "mentions":
        void this.search.mentions(action.workspaceId, action.query);
        break;
      case "folders":
        void this.search.folders(action.query);
        break;
      case "addProject":
        void this.search.addProject(action.path, action.requestId);
        break;
      case "create":
        void this.newThread.create(action);
        break;
    }
    return true;
  }
  files(raw: unknown): boolean {
    const parsed = FilesAction.safeParse(raw);
    if (!parsed.success) return false;
    const action = parsed.data;
    switch (action.kind) {
      case "open":
        void this.checkout.open(action.threadId);
        break;
      case "openProject":
        void this.checkout.openProject(action.workspaceId);
        break;
      case "folder":
        this.checkout.folder(action.path);
        break;
      case "search":
        void this.checkout.search(action.query);
        break;
      case "preview":
        void this.checkout.preview(action.path);
        break;
      case "close":
        this.checkout.close();
        break;
    }
    return true;
  }
}
