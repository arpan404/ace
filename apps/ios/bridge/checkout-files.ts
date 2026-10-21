import { readFile, type ClientCore } from "@ace/client";
import { downloadFile } from "@ace/client/files";
import { GitStatusFile, ThreadId, WorkspaceFileChange, type FileOperation } from "@ace/protocol";
import {
  CheckoutError,
  checkoutEditLimit,
  checkoutError,
  checkoutViewLimit,
  fileLanguage,
  fromCode,
  imageType,
  isCheckoutPath,
  isMarkdownPath,
  isText,
  parentPath,
  pathParts,
} from "@ace/ui-core";
import { checkoutLinkPath, localLinkLine, localLinkPath } from "@ace/ui-core/file-references";
import { z } from "zod";
import { base64, gather } from "./bytes.ts";
import { changedLines, colourRuns } from "./checkout-colours.ts";
import {
  Listing,
  Stat,
  Trash,
  type FilesOperation,
  type FilesScope,
  type NativeFilesRequest,
} from "./checkout-request.ts";
import { checkoutTree, searchRows } from "./checkout-tree.ts";

/*
 * The Files screen's requests (`native.files`), answered one at a time like the web's checkout
 * source: a thread's checkout (the daemon resolves its worktree), or from New thread a project's
 * own folder, read-only. Reads, writes and management go through `files.request` with the same
 * version checks the web makes; failures come back as the shared one-sentence error.
 */

/** What the Files screen needs of the SDK. */
export type FilesOwner = Pick<
  ClientCore,
  "request" | "state" | "connectionState" | "send" | "cachedThread"
>;
/** A project's file search before a thread exists (`ComposeSearch.complete`). */
export type ProjectSearch = (
  workspaceId: string,
  query: string,
  limit: number,
) => Promise<string[]>;

/** The most Share or a linked file carries to the phone. */
export const shareLimit = 16 * 1024 * 1024;
const searchLimit = 50;
type Scope = FilesScope;
type Operation = FilesOperation;
const quiet = { timeoutMs: 20_000 };
const failed = (error: unknown) => {
  const parsed = checkoutError(error);
  return { ok: false, code: parsed.code, message: parsed.message };
};

export class CheckoutFiles {
  readonly #owner: FilesOwner;
  readonly #projectSearch: ProjectSearch;
  constructor(owner: FilesOwner, projectSearch: ProjectSearch) {
    this.#owner = owner;
    this.#projectSearch = projectSearch;
  }

  /** One request's answer: `ok: true` with its fields, or `ok: false` with the sentence. */
  async request(input: NativeFilesRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
    try {
      return { ok: true, ...(await this.#run(input.scope, input.operation, signal)) };
    } catch (error) {
      return failed(error);
    }
  }

  async #run(scope: Scope, op: Operation, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (op.op === "tree") return this.#tree(scope, signal);
    if (op.op === "search") return this.#search(scope, op.query, signal);
    if (op.op === "read") return this.#read(scope, op.path, signal);
    if (op.op === "download") {
      const bytes = await this.#bytes(scope, { op: "download", path: op.path, offset: 0 }, signal);
      return { name: pathParts(op.path).name, data: base64(bytes) };
    }
    // Everything past here changes the checkout or reads a thread's message: never a project's.
    if (!("threadId" in scope)) throw fromCode("FORBIDDEN");
    const threadId = scope.threadId;
    switch (op.op) {
      case "link":
        return this.#link(threadId, op.itemId, op.reference);
      case "linked": {
        const bytes = await this.#bytes(
          scope,
          { op: "link.download", itemId: op.itemId, reference: op.reference, offset: 0 },
          signal,
        );
        return {
          name: pathParts(localLinkPath(op.reference) ?? op.reference).name,
          data: base64(bytes),
        };
      }
      case "trash":
        return Trash.parse(
          await this.#files(
            scope,
            { op: "trash.list", limit: 64, ...(op.after ? { after: op.after } : {}) },
            signal,
          ),
        );
      case "write":
        return this.#write(scope, op.path, op.text, op.expected, signal);
      case "create":
        return this.#mutate(
          scope,
          { op: "create", path: op.path, expected: null, text: "" },
          signal,
        );
      case "mkdir":
        return this.#mutate(scope, { op: "mkdir", path: op.path, expected: null }, signal);
      case "restore":
        return this.#mutate(
          scope,
          { op: "restore", trashId: op.trashId, path: op.path, expected: null },
          signal,
        );
      case "delete": {
        const expected = await this.#current(scope, op.path, signal);
        return this.#mutate(scope, { op: "delete", path: op.path, expected }, signal);
      }
      case "rename":
      case "move": {
        if (op.op === "rename" && parentPath(op.destination) !== parentPath(op.path))
          throw new CheckoutError(
            "rename",
            "Keep the same folder when renaming. Use Move to change folders.",
          );
        const expected = await this.#current(scope, op.path, signal);
        return this.#mutate(
          scope,
          {
            op: op.op,
            path: op.path,
            expected,
            destination: op.destination,
            destinationExpected: null,
          },
          signal,
        );
      }
    }
  }

  async #files(scope: Scope, operation: FileOperation, signal: AbortSignal): Promise<unknown> {
    const reply = await this.#owner
      .request({ type: "files.request", ...scope, operation }, { ...quiet, signal })
      .catch((error: unknown) => {
        throw checkoutError(error);
      });
    if (reply.type === "files.error") throw fromCode(reply.code);
    if (reply.type !== "files.result")
      throw new CheckoutError("protocol", "Couldn't read the reply. Try again.");
    return reply.value;
  }

  async #workspace(threadId: string, op: "git.status" | "git.diff", signal: AbortSignal) {
    const reply = await this.#owner.request(
      { type: "workspace.request", operation: { op, threadId: ThreadId.parse(threadId) } },
      { ...quiet, signal },
    );
    return reply.result;
  }

  async #tree(scope: Scope, signal: AbortSignal) {
    const [listing, status] = await Promise.all([
      this.#files(scope, { op: "list", path: "", limit: 1000 }, signal).then((value) =>
        Listing.parse(value),
      ),
      // The marks are extra: a checkout git can't read still lists its files.
      "threadId" in scope
        ? this.#workspace(scope.threadId, "git.status", signal).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const changes =
      status?.kind === "gitStatus" ? z.array(GitStatusFile).catch([]).parse(status.files) : [];
    return { ...checkoutTree(listing.paths, changes), truncated: listing.truncated };
  }

  async #search(scope: Scope, query: string, signal: AbortSignal) {
    let paths: string[];
    if ("workspaceId" in scope)
      paths = await this.#projectSearch(scope.workspaceId, query, searchLimit);
    else {
      const reply = await this.#owner
        .request(
          {
            type: "context.request",
            operation: {
              op: "mention.complete",
              threadId: scope.threadId,
              query: query.slice(0, 128),
              limit: searchLimit,
            },
          },
          { ...quiet, signal },
        )
        .catch((error: unknown) => {
          throw checkoutError(error);
        });
      if (reply.result.kind === "error") throw fromCode(reply.result.code);
      if (reply.result.kind !== "completion")
        throw new CheckoutError("protocol", "Couldn't read the reply. Try again.");
      paths = reply.result.paths;
    }
    return { query, rows: searchRows(query, paths.filter(isCheckoutPath).slice(0, searchLimit)) };
  }

  async #stat(scope: Scope, path: string, signal: AbortSignal) {
    if (!isCheckoutPath(path)) throw fromCode("OUTSIDE_WORKSPACE");
    const stat = Stat.parse(await this.#files(scope, { op: "stat", path }, signal));
    return { version: stat.version ?? null, size: stat.size, folder: stat.type === "directory" };
  }

  /** The version a change replaces; a path gone meanwhile can't be changed. */
  async #current(scope: Scope, path: string, signal: AbortSignal): Promise<string> {
    const { version } = await this.#stat(scope, path, signal);
    if (version === null)
      throw new CheckoutError("gone", "This path is gone. Refresh and try again.");
    return version;
  }

  async #bytes(
    scope: Scope,
    operation: Extract<FileOperation, { op: "download" | "link.download" }>,
    signal: AbortSignal,
    limit = shareLimit,
  ): Promise<Uint8Array> {
    const chunks = downloadFile(
      this.#owner,
      { ...scope, ...operation },
      { signal, timeoutMs: 30_000 },
    );
    const result = await gather(
      (async function* () {
        try {
          yield* chunks;
        } catch (error) {
          throw checkoutError(error);
        }
      })(),
      limit,
    );
    if ("over" in result)
      throw new CheckoutError("too_large", "This file is over 16 MB. Get it on your computer.");
    return result.bytes;
  }

  async #read(scope: Scope, path: string, signal: AbortSignal) {
    if (!isCheckoutPath(path)) throw fromCode("OUTSIDE_WORKSPACE");
    // One round trip for most files: details and the first part together, any rest in parallel.
    const read = await readFile(
      this.#owner,
      { ...scope, path, maxSize: checkoutViewLimit },
      { signal, timeoutMs: 30_000 },
    ).catch((error: unknown) => {
      throw checkoutError(error);
    });
    if (read.kind === "missing") return { kind: "missing", path };
    if (read.kind === "folder")
      throw new CheckoutError("folder", "That's a folder; pick a file inside it.");
    const { version } = read;
    const editable = "threadId" in scope;
    if (read.kind === "large")
      return { kind: "large", path, size: read.size, version, editable: false };
    const bytes = read.bytes;
    const size = bytes.length;
    const image = imageType(path);
    if (image && image !== "image/svg+xml")
      return { kind: "image", path, size, version, editable: false, data: base64(bytes) };
    if (!isText(bytes)) return { kind: "binary", path, size, version, editable: false };
    const text = new TextDecoder().decode(bytes);
    const [colours, marks] = await Promise.all([
      colourRuns(text, fileLanguage(path)),
      "threadId" in scope ? this.#marks(scope.threadId, path, signal) : Promise.resolve([]),
    ]);
    return {
      kind: "text",
      path,
      size,
      version,
      text,
      markdown: isMarkdownPath(path),
      editable: editable && size <= checkoutEditLimit,
      colours: colours?.colours ?? [],
      runs: colours?.runs ?? [],
      marks,
    };
  }

  /** The file's lines changed since the last commit; none while the checkout has no change. */
  async #marks(threadId: string, path: string, signal: AbortSignal) {
    if (this.#owner.cachedThread(threadId)?.thread?.details?.diff?.files === 0) return [];
    const result = await this.#workspace(threadId, "git.diff", signal).catch(() => undefined);
    return result?.kind === "gitDiff" ? changedLines(result.patch, path) : [];
  }

  async #mutate(scope: Scope, operation: FileOperation, signal: AbortSignal) {
    const change = WorkspaceFileChange.parse(await this.#files(scope, operation, signal));
    return {
      path: change.path,
      ...(change.destination ? { destination: change.destination } : {}),
      ...(change.trashId ? { trashId: change.trashId } : {}),
      ...(change.version ? { version: change.version } : {}),
    };
  }

  /**
   * Save typed text over the version it was opened at. A file that changed meanwhile isn't
   * overwritten: the reply names its new version (to replace it on purpose) or says it's gone.
   */
  async #write(scope: Scope, path: string, text: string, expected: string, signal: AbortSignal) {
    try {
      const saved = await this.#mutate(scope, { op: "write", path, expected, text }, signal);
      if (!saved.version)
        throw new CheckoutError(
          "unconfirmed",
          "Couldn't confirm the saved file. Refresh to check it.",
        );
      return { version: saved.version };
    } catch (error) {
      if (checkoutError(error).code !== "CONFLICT") throw error;
      const latest = await this.#stat(scope, path, signal);
      if (latest.version === null)
        throw new CheckoutError(
          "deleted",
          "This file was deleted. Copy your edits, then create a new file.",
        );
      return { conflict: latest.version };
    }
  }

  /**
   * Where a message's local link lands: a checkout file (opened in Files, at its line), or a
   * file outside the checkout only the host can serve because this message links it.
   */
  #link(threadId: string, itemId: string, target: string) {
    const local = localLinkPath(target);
    if (!local) return { kind: "none" };
    const reader = this.#owner.cachedThread(threadId);
    const details = reader?.thread?.details;
    const root = details?.worktree ?? details?.workspace?.path;
    const agentId = reader?.item(itemId)?.agentId;
    const cwd = agentId ? reader?.agent(agentId)?.cwd : undefined;
    const relative = checkoutLinkPath(local, root, cwd);
    const line = localLinkLine(target);
    if (relative && isCheckoutPath(relative))
      return { kind: "checkout", path: relative, ...(line ? { line } : {}) };
    return { kind: "linked", name: pathParts(local).name };
  }
}
