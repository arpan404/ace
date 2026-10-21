import { FILE_READ_PART, FileReadResult, type ThreadId, type WorkspaceId } from "@ace/protocol";
import type { ServiceRequest, ServiceResponse } from "./service-requests.ts";
import { decodeBase64 } from "./base64.ts";
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

/** Parts of a big file asked for at once; the daemon admits eight requests per connection. */
const inFlight = 4;
const gzip = typeof DecompressionStream === "function";

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type FilesRequest = Extract<ServiceRequest, { type: "files.request" }>;
/** What reading needs of a client: `ClientApi` has it. */
export interface FileReader {
  request(input: FilesRequest, options?: RequestOptions): Promise<ServiceResponse<FilesRequest>>;
}
type Reader = FileReader;

async function part(
  client: Reader,
  input: FileReadInput,
  offset: number,
  validator: string | undefined,
  options: RequestOptions,
): Promise<{ result: FileReadResult; bytes: Uint8Array<ArrayBuffer> | undefined }> {
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
        encodings: gzip ? ["gzip"] : [],
        ...(validator ? { validator } : {}),
      },
    },
    options,
  );
  if (reply.type === "files.error") throw new ClientError("daemon", reply.code);
  if (reply.type !== "files.result") throw new ClientError("protocol");
  const parsed = FileReadResult.safeParse(reply.value);
  if (!parsed.success) throw new ClientError("protocol");
  const result = parsed.data;
  if (result.data === undefined) return { result, bytes: undefined };
  const raw = decodeBase64(result.data, FILE_READ_PART);
  const bytes = result.encoding === "gzip" ? await gunzip(raw) : raw;
  if (bytes.length > FILE_READ_PART || result.offset !== offset) throw new ClientError("protocol");
  return { result, bytes };
}

async function readOnce(
  client: Reader,
  input: FileReadInput,
  options: RequestOptions,
): Promise<FileReadOutcome> {
  const first = await part(client, input, 0, undefined, options);
  const { version, type, size } = first.result;
  if (version === null) return { kind: "missing" };
  if (type === "directory") return { kind: "folder" };
  if (size === undefined) throw new ClientError("protocol");
  if (!first.bytes) return { kind: "large", size, version };
  if (first.bytes.length === size) return { kind: "file", bytes: first.bytes, version };
  // The rest of a big file: every part at once (a few in flight), each pinned to this version.
  const bytes = new Uint8Array(size);
  bytes.set(first.bytes, 0);
  const offsets: number[] = [];
  for (let at = first.bytes.length; at < size; at += FILE_READ_PART) offsets.push(at);
  let next = 0;
  const worker = async () => {
    while (next < offsets.length) {
      const offset = offsets[next++] ?? 0;
      const read = await part(client, input, offset, version, options);
      const expected = Math.min(FILE_READ_PART, size - offset);
      if (!read.bytes || read.bytes.length !== expected || read.result.size !== size)
        throw new ClientError("protocol");
      bytes.set(read.bytes, offset);
    }
  };
  await Promise.all(Array.from({ length: Math.min(inFlight, offsets.length) }, worker));
  return { kind: "file", bytes, version };
}

/**
 * A file to show, in as few round trips as possible: its details and first 256 KiB in one reply
 * (gzip-compressed where the platform can expand it), then any further parts in parallel. A file
 * that changes between parts is read once more from the start.
 */
export async function readFile(
  client: Reader,
  input: FileReadInput,
  options: RequestOptions = {},
): Promise<FileReadOutcome> {
  try {
    return await readOnce(client, input, options);
  } catch (error) {
    if (!(error instanceof ClientError && error.message === "CONFLICT")) throw error;
    return readOnce(client, input, options);
  }
}
