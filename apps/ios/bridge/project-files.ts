import type { ClientCore } from "@ace/client";
import { downloadFile } from "@ace/client/files";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { buildFileTree, isText, type FileTreeNode } from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";

/*
 * A thread's checkout, or a project's own folder before any thread exists (New thread), read-only,
 * for the Files sheet: the daemon's bounded path listing (`files.request list`, at most 1,000
 * paths) shown one folder at a time, search through the daemon's own completion, and a
 * size-capped text preview. Past a cap the sheet says how much more there is and points to the
 * computer.
 */

export type FilesOwner = Pick<ClientCore, "request" | "state" | "connectionState" | "send">;
/** A project's file search before a thread exists (`ComposeSearch.complete`). */
export type ProjectSearch = (
  workspaceId: string,
  query: string,
  limit: number,
) => Promise<string[]>;
/** Whose files the sheet shows; patches carry the same key so Swift can tell them apart. */
type Scope = { threadId: string } | { workspaceId: string };
const wireScope = (scope: Scope) =>
  "threadId" in scope
    ? { threadId: ThreadId.parse(scope.threadId) }
    : { workspaceId: WorkspaceId.parse(scope.workspaceId) };

/** What one folder, one search and one preview may carry to Swift. */
export const filesLimits = {
  /** Paths the daemon lists for a checkout. */
  listed: 1000,
  /** Rows of one folder; the rest are counted. */
  rows: 200,
  /** Search results. */
  matches: 50,
  /** Bytes read for a preview. */
  bytes: 128 * 1024,
  lines: 2000,
  /** UTF-16 units of one line and of the whole preview. */
  lineUnits: 1000,
  units: 96_000,
} as const;

const Listing = z.object({ paths: z.array(z.string()), truncated: z.boolean() });
const quiet = { timeoutMs: 15_000 };

export class ProjectFiles {
  #owner: FilesOwner;
  #sink: PatchSink;
  #preview: Preview;
  #projectSearch: ProjectSearch;
  #scope: Scope | undefined;
  #tree: { folders: Map<string, FileTreeNode[]>; truncated: boolean } | undefined;
  #reading: AbortController | undefined;
  constructor(owner: FilesOwner, sink: PatchSink, preview: Preview, projectSearch: ProjectSearch) {
    this.#owner = owner;
    this.#sink = sink;
    this.#preview = preview;
    this.#projectSearch = projectSearch;
  }

  /** Read the thread's checkout and show its top folder. */
  open(threadId: string): Promise<void> {
    return this.#open({ threadId });
  }

  /** Read a project's own folder, before any thread exists, and show its top folder. */
  openProject(workspaceId: string): Promise<void> {
    return this.#open({ workspaceId });
  }

  async #open(scope: Scope): Promise<void> {
    this.close();
    this.#scope = scope;
    this.#listing("", "loading");
    try {
      const reply = await this.#owner.request(
        {
          type: "files.request",
          ...wireScope(scope),
          operation: { op: "list", path: "", limit: filesLimits.listed },
        },
        quiet,
      );
      if (this.#scope !== scope) return;
      if (reply.type !== "files.result") throw new Error(reply.type);
      const listing = Listing.parse(reply.value);
      const folders = new Map<string, FileTreeNode[]>();
      const index = (nodes: FileTreeNode[], path: string) => {
        folders.set(path, nodes);
        for (const node of nodes) if (node.kind === "folder") index(node.children, node.path);
      };
      index(buildFileTree(listing.paths.slice(0, filesLimits.listed)), "");
      this.#tree = { folders, truncated: listing.truncated };
      this.#listing("", "ready");
    } catch {
      if (this.#scope === scope) this.#listing("", "failed");
    }
  }

  /** One folder's rows, from the listing already read. */
  folder(path: string): void {
    this.#listing(path, this.#tree ? "ready" : "loading");
  }

  async search(query: string): Promise<void> {
    const scope = this.#scope;
    if (!scope) return;
    const put = (state: string, paths: string[]) =>
      this.#sink.put("files:search", () => ({
        type: "files.search",
        ...scope,
        query,
        state,
        paths,
      }));
    put("loading", []);
    try {
      const paths = await this.#complete(scope, query);
      if (this.#scope !== scope) return;
      put(
        "ready",
        paths.slice(0, filesLimits.matches).map((path) => this.#preview(path, 1024)),
      );
    } catch {
      if (this.#scope === scope) put("failed", []);
    }
  }

  async #complete(scope: Scope, query: string): Promise<string[]> {
    if ("workspaceId" in scope)
      return this.#projectSearch(scope.workspaceId, query, filesLimits.matches);
    const reply = await this.#owner.request(
      {
        type: "context.request",
        operation: {
          op: "mention.complete",
          threadId: ThreadId.parse(scope.threadId),
          query: query.slice(0, 128),
          limit: filesLimits.matches,
        },
      },
      quiet,
    );
    if (reply.result.kind !== "completion") throw new Error(reply.result.kind);
    return reply.result.paths;
  }

  /** Read the start of one file: text within the caps, or why it isn't shown. */
  async preview(path: string): Promise<void> {
    const scope = this.#scope;
    if (!scope) return;
    this.#reading?.abort();
    const reading = new AbortController();
    this.#reading = reading;
    const put = (fields: Record<string, unknown>) =>
      this.#sink.put("files:preview", () => ({
        type: "files.preview",
        ...scope,
        path,
        text: "",
        truncated: false,
        binary: false,
        ...fields,
      }));
    put({ state: "loading" });
    try {
      const chunks: Uint8Array[] = [];
      let read = 0;
      let more = false;
      for await (const chunk of downloadFile(
        this.#owner,
        { ...wireScope(scope), op: "download", path, offset: 0 },
        { signal: reading.signal, timeoutMs: 15_000 },
      )) {
        const room = filesLimits.bytes - read;
        chunks.push(chunk.subarray(0, room));
        read += Math.min(room, chunk.length);
        // Leaving the loop cancels the transfer; nothing past the cap is read.
        if (chunk.length > room) {
          more = true;
          break;
        }
      }
      if (this.#reading !== reading) return;
      const bytes = new Uint8Array(read);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      if (!isText(bytes, more)) {
        put({ state: "ready", binary: true });
        return;
      }
      const shown = previewText(new TextDecoder().decode(bytes));
      put({ state: "ready", text: shown.text, truncated: more || shown.truncated });
    } catch {
      if (this.#reading === reading) put({ state: "failed" });
    }
  }

  close(): void {
    this.#reading?.abort();
    this.#reading = undefined;
    this.#scope = undefined;
    this.#tree = undefined;
    this.#sink.clear("files:");
  }

  #listing(folder: string, state: string): void {
    const scope = this.#scope;
    const nodes = this.#tree?.folders.get(folder) ?? [];
    const truncated = this.#tree?.truncated ?? false;
    this.#sink.put("files:listing", () => ({
      type: "files.listing",
      ...scope,
      folder,
      state: this.#tree && !this.#tree.folders.has(folder) ? "missing" : state,
      rows: nodes.slice(0, filesLimits.rows).map((node) => ({
        path: this.#preview(node.path, 1024),
        name: this.#preview(node.name, 256),
        folder: node.kind === "folder",
      })),
      hidden: Math.max(0, nodes.length - filesLimits.rows),
      truncated,
    }));
  }
}

/** The text a preview shows: whole lines within the line and unit caps. */
export function previewText(text: string): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  const out: string[] = [];
  let units = 0;
  let truncated = lines.length > filesLimits.lines;
  for (const line of lines.slice(0, filesLimits.lines)) {
    const shown = line.length > filesLimits.lineUnits ? line.slice(0, filesLimits.lineUnits) : line;
    if (shown !== line) truncated = true;
    if (units + shown.length + 1 > filesLimits.units) {
      truncated = true;
      break;
    }
    out.push(shown);
    units += shown.length + 1;
  }
  return { text: out.join("\n"), truncated };
}
