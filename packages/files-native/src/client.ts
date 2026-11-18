import { FilesRequestError, type FilesRequestOptions } from "./errors.ts";
import type { FilesProcess, FilesSearchOptions, FilesWatch } from "./process.ts";
import type { EventPayload, Reply, SearchQuery, Summary } from "./schemas.ts";

/** The plan's default page size and hide list, shared with the daemon. */
export const filesListDefaults = { limit: 500, hide: [".git", ".DS_Store"] } as const;

export type FilesListOptions = FilesRequestOptions & {
  limit?: number | undefined;
  cursor?: string | undefined;
  hide?: string[] | undefined;
  /** Page one pinned listing, for a traversal that must not fail on a changing folder. */
  snapshot?: boolean | undefined;
};
export type FilesReadOptions = FilesRequestOptions & {
  offset?: number | undefined;
  length?: number | undefined;
  maxSize?: number | undefined;
};
export type FilesWriteOptions = FilesRequestOptions & { expected?: string | undefined };

export type PageReply = Extract<Reply, { type: "page" }>;
export type EntryReply = Extract<Reply, { type: "entry" }>;
export type DescriptionReply = Extract<Reply, { type: "description" }>;
export type ReadReply = Extract<Reply, { type: "read" }>;
export type VersionReply = Extract<Reply, { type: "version" }>;
export type IndexReply = Extract<Reply, { type: "index" }>;

/**
 * The typed surface over one `FilesProcess`: every op in the files-wire section, with the wire's
 * tagged reply types and optional fields left out when absent.
 */
export class FilesClient {
  readonly #process: FilesProcess;

  constructor(process: FilesProcess) {
    this.#process = process;
  }

  get process(): FilesProcess {
    return this.#process;
  }

  start(): Promise<void> {
    return this.#process.start();
  }

  dispose(): void {
    this.#process.dispose();
  }

  async openRoot(path: string): Promise<number> {
    return this.#process.openRoot(path);
  }

  async closeRoot(root: number): Promise<void> {
    return this.#process.closeRoot(root);
  }

  async list(root: number, dir: string, options: FilesListOptions = {}): Promise<PageReply> {
    const { reply } = await this.#process.request(
      {
        op: "list",
        root,
        dir,
        limit: options.limit ?? filesListDefaults.limit,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        hide: options.hide ?? [...filesListDefaults.hide],
        ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
      },
      options,
    );
    if (reply.type !== "page") throw unexpected("list", reply);
    return reply;
  }

  async stat(root: number, path: string, options: FilesRequestOptions = {}): Promise<EntryReply> {
    const { reply } = await this.#process.request({ op: "stat", root, path }, options);
    if (reply.type !== "entry") throw unexpected("stat", reply);
    return reply;
  }

  async describe(
    root: number,
    path: string,
    options: FilesRequestOptions = {},
  ): Promise<DescriptionReply> {
    const { reply } = await this.#process.request({ op: "describe", root, path }, options);
    if (reply.type !== "description") throw unexpected("describe", reply);
    return reply;
  }

  /** The entry itself: its own version, never a folder's tree digest. */
  async describeEntry(
    root: number,
    path: string,
    options: FilesRequestOptions = {},
  ): Promise<DescriptionReply> {
    const { reply } = await this.#process.request({ op: "describeEntry", root, path }, options);
    if (reply.type !== "description") throw unexpected("describeEntry", reply);
    return reply;
  }

  /** Refuse a mutation path with a link on the way, before any mutation op runs. */
  async checkMutation(
    root: number,
    path: string,
    options: FilesRequestOptions = {},
  ): Promise<void> {
    const { reply } = await this.#process.request({ op: "checkMutation", root, path }, options);
    if (reply.type !== "done") throw unexpected("checkMutation", reply);
  }

  async measure(
    root: number,
    path: string,
    options: FilesRequestOptions = {},
  ): Promise<{ bytes: number; shallow: boolean }> {
    const { reply } = await this.#process.request({ op: "measure", root, path }, options);
    if (reply.type !== "measure") throw unexpected("measure", reply);
    return { bytes: reply.bytes, shallow: reply.shallow };
  }

  async read(
    root: number,
    path: string,
    options: FilesReadOptions = {},
  ): Promise<{ meta: ReadReply; bytes: Uint8Array }> {
    const { reply, body } = await this.#process.request(
      {
        op: "read",
        root,
        path,
        offset: options.offset ?? 0,
        length: options.length ?? 65_536,
        ...(options.maxSize === undefined ? {} : { maxSize: options.maxSize }),
      },
      options,
    );
    if (reply.type !== "read") throw unexpected("read", reply);
    return { meta: reply, bytes: body };
  }

  async write(
    root: number,
    path: string,
    bytes: Uint8Array,
    options: FilesWriteOptions = {},
  ): Promise<VersionReply> {
    const { reply } = await this.#process.request(
      {
        op: "write",
        root,
        path,
        ...(options.expected === undefined ? {} : { expected: options.expected }),
      },
      { ...options, body: bytes },
    );
    if (reply.type !== "version") throw unexpected("write", reply);
    return reply;
  }

  async createFile(
    root: number,
    path: string,
    bytes: Uint8Array,
    options: FilesRequestOptions = {},
  ): Promise<VersionReply> {
    const { reply } = await this.#process.request(
      { op: "createFile", root, path },
      { ...options, body: bytes },
    );
    if (reply.type !== "version") throw unexpected("createFile", reply);
    return reply;
  }

  async createDir(root: number, path: string, options: FilesRequestOptions = {}): Promise<void> {
    const { reply } = await this.#process.request({ op: "createDir", root, path }, options);
    if (reply.type !== "done") throw unexpected("createDir", reply);
  }

  async rename(
    root: number,
    from: string,
    to: string,
    overwrite = false,
    options: FilesRequestOptions = {},
  ): Promise<void> {
    const { reply } = await this.#process.request(
      { op: "rename", root, from, to, overwrite },
      options,
    );
    if (reply.type !== "done") throw unexpected("rename", reply);
  }

  async remove(root: number, path: string, options: FilesRequestOptions = {}): Promise<void> {
    const { reply } = await this.#process.request({ op: "remove", root, path }, options);
    if (reply.type !== "done") throw unexpected("remove", reply);
  }

  watch(root: number, onBatch: (payload: EventPayload) => void): Promise<FilesWatch> {
    return this.#process.watch(root, onBatch);
  }

  async indexQuery(
    root: number,
    query: string,
    limit = 50,
    options: FilesRequestOptions = {},
  ): Promise<IndexReply> {
    const { reply } = await this.#process.request(
      { op: "indexQuery", root, query, limit },
      options,
    );
    if (reply.type !== "index") throw unexpected("indexQuery", reply);
    return reply;
  }

  search(root: number, query: SearchQuery, options: FilesSearchOptions): Promise<Summary> {
    return this.#process.search(root, query, options);
  }
}

function unexpected(op: string, reply: Reply): FilesRequestError {
  return new FilesRequestError("INVALID_ARGUMENT", `ace-files answered ${op} with ${reply.type}`);
}
