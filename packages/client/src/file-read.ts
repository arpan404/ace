import { FILE_READ_PART, FileReadResult, type ThreadId, type WorkspaceId } from "@ace/protocol";
import type { ServiceRequest, ServiceResponse } from "./service-requests.ts";
import { decodeBase64 } from "./base64.ts";
import { canInflate, inflate } from "./inflate.ts";
import { readBudgetOf, type ReadPriority, type ReadTicket } from "./file-read-budget.ts";
import { ClientError, type RequestOptions } from "./types.ts";

export interface FileReadInput {
  threadId?: ThreadId;
  workspaceId?: WorkspaceId;
  path: string;
  /** Larger files come back as `large`, without their bytes. */
  maxSize: number;
}

export type FileReadOutcome =
  | { kind: "missing" }
  | { kind: "folder" }
  | { kind: "large"; size: number; version: string }
  | { kind: "file"; bytes: Uint8Array<ArrayBuffer>; version: string };

export interface FileReadOptions extends RequestOptions {
  /**
   * Where this read waits behind the connection's others: "visible" by default. A function is
   * asked again before each part, so a prefetch the person then opens can move up.
   */
  priority?: ReadPriority | (() => ReadPriority);
}

type FilesRequest = Extract<ServiceRequest, { type: "files.request" }>;
/** What reading needs of a client: `ClientApi` has it. */
export interface FileReader {
  request(input: FilesRequest, options?: RequestOptions): Promise<ServiceResponse<FilesRequest>>;
}
type Reader = FileReader;

interface Line {
  ticket: ReadTicket;
  options: RequestOptions;
}

/** A line in the connection's read budget for one file, plus the request options to send. */
function line(client: Reader, options: FileReadOptions): Line {
  const { priority, ...request } = options;
  return {
    ticket: readBudgetOf(client).ticket(priority ?? "visible", request.signal),
    options: request,
  };
}

async function part(
  client: Reader,
  input: FileReadInput,
  offset: number,
  validator: string | undefined,
  { ticket, options }: Line,
): Promise<{ result: FileReadResult; bytes: Uint8Array<ArrayBuffer> | undefined }> {
  const reply = await readBudgetOf(client).run(ticket, () =>
    send(client, input, offset, validator, options),
  );
  if (reply.type === "files.error") throw new ClientError("daemon", reply.code);
  if (reply.type !== "files.result") throw new ClientError("protocol");
  return decodePart(reply.value, offset);
}

async function send(
  client: Reader,
  input: FileReadInput,
  offset: number,
  validator: string | undefined,
  options: RequestOptions,
) {
  const reply = await client.request(
    {
      type: "files.request",
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      operation: {
        op: "read",
        path: input.path,
        offset,
        length: FILE_READ_PART,
        maxSize: input.maxSize,
        encodings: canInflate() ? ["gzip"] : [],
        ...(validator ? { validator } : {}),
      },
    },
    options,
  );
  // BUSY is thrown here, inside the budget's slot, so the budget can back off and retry it.
  if (reply.type === "files.error" && reply.code === "BUSY")
    throw new ClientError("daemon", "BUSY");
  return reply;
}

async function decodePart(
  value: unknown,
  offset: number,
): Promise<{ result: FileReadResult; bytes: Uint8Array<ArrayBuffer> | undefined }> {
  const parsed = FileReadResult.safeParse(value);
  if (!parsed.success) throw new ClientError("protocol");
  const result = parsed.data;
  if (result.data === undefined) return { result, bytes: undefined };
  const raw = decodeBase64(result.data, FILE_READ_PART);
  // A part never expands past its own size: anything more is a broken reply.
  const bytes =
    result.encoding === "gzip"
      ? await inflate("gzip", raw, FILE_READ_PART).catch(() => {
          throw new ClientError("protocol");
        })
      : raw;
  if (bytes.length > FILE_READ_PART || result.offset !== offset) throw new ClientError("protocol");
  return { result, bytes };
}

async function readOnce(client: Reader, input: FileReadInput, at: Line): Promise<FileReadOutcome> {
  const first = await part(client, input, 0, undefined, at);
  const { version, type, size } = first.result;
  if (version === null) return { kind: "missing" };
  if (type === "directory") return { kind: "folder" };
  if (size === undefined) throw new ClientError("protocol");
  if (!first.bytes) return { kind: "large", size, version };
  if (first.bytes.length === size) return { kind: "file", bytes: first.bytes, version };
  // The rest of a big file: every part queued at once in the connection's budget, each pinned to
  // this version. One part failing withdraws the rest.
  const bytes = new Uint8Array(size);
  bytes.set(first.bytes, 0);
  const offsets: number[] = [];
  for (let from = first.bytes.length; from < size; from += FILE_READ_PART) offsets.push(from);
  const stop = new AbortController();
  const outer = at.options.signal;
  const abort = () => stop.abort();
  if (outer?.aborted) stop.abort();
  outer?.addEventListener("abort", abort, { once: true });
  const rest: Line = {
    ticket: { ...at.ticket, signal: stop.signal },
    options: { ...at.options, signal: stop.signal },
  };
  try {
    await Promise.all(
      offsets.map(async (offset) => {
        const read = await part(client, input, offset, version, rest);
        const expected = Math.min(FILE_READ_PART, size - offset);
        if (!read.bytes || read.bytes.length !== expected || read.result.size !== size)
          throw new ClientError("protocol");
        bytes.set(read.bytes, offset);
      }),
    ).catch((error: unknown) => {
      stop.abort();
      throw error;
    });
  } finally {
    outer?.removeEventListener("abort", abort);
  }
  return { kind: "file", bytes, version };
}

/**
 * A file to show, in as few round trips as possible: its details and first 256 KiB in one reply
 * (gzip-compressed where the platform can expand it), then any further parts in parallel within
 * the connection's read budget. A file that changes between parts is read once more from the
 * start.
 */
export async function readFile(
  client: Reader,
  input: FileReadInput,
  options: FileReadOptions = {},
): Promise<FileReadOutcome> {
  const at = line(client, options);
  try {
    return await readOnce(client, input, at);
  } catch (error) {
    if (!(error instanceof ClientError && error.message === "CONFLICT")) throw error;
    return readOnce(client, input, at);
  }
}

export interface FileRangeInput {
  threadId?: ThreadId;
  workspaceId?: WorkspaceId;
  path: string;
  offset: number;
  /** The version the first part was read at; a changed file refuses with CONFLICT. */
  validator?: string | undefined;
}

/**
 * One part of a file however big it is (at most 256 KiB from `offset`), for reading a file too
 * large to show whole a page at a time.
 */
export async function readFileRange(
  client: Reader,
  input: FileRangeInput,
  options: FileReadOptions = {},
): Promise<FileReadOutcome & { offset?: number; size?: number }> {
  const { result, bytes } = await part(
    client,
    {
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      path: input.path,
      maxSize: Number.MAX_SAFE_INTEGER,
    },
    input.offset,
    input.validator,
    line(client, options),
  );
  if (result.version === null) return { kind: "missing" };
  if (result.type === "directory") return { kind: "folder" };
  if (result.size === undefined || !bytes) throw new ClientError("protocol");
  return { kind: "file", bytes, version: result.version, offset: input.offset, size: result.size };
}
