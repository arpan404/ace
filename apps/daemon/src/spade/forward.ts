import { request, type IncomingMessage } from "node:http";
import { sseDecoder, SseTooLarge, type SseEvent } from "./sse.ts";

/** Where a ready Spade listens, and the token its API needs. */
export interface SpadeConnection {
  host: string;
  port: number;
  token: string;
}
export type SpadeAnswer =
  | { kind: "response"; status: number; body: Buffer; contentType?: string | undefined }
  | { kind: "too_large" };

function headersFor(
  connection: SpadeConnection,
  input: { accept?: string; contentType?: string | undefined; length?: number },
  authorized: boolean,
): Record<string, string> {
  const headers: Record<string, string> = { accept: input.accept ?? "application/json" };
  if (authorized) headers.authorization = `Bearer ${connection.token}`;
  if (input.contentType !== undefined) headers["content-type"] = input.contentType;
  if (input.length !== undefined) headers["content-length"] = String(input.length);
  return headers;
}

function send(
  connection: SpadeConnection,
  input: {
    method: string;
    path: string;
    body?: Buffer | undefined;
    contentType?: string | undefined;
    accept?: string;
  },
  signal: AbortSignal,
  authorized = true,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const headers = headersFor(
      connection,
      {
        ...(input.accept ? { accept: input.accept } : {}),
        ...(input.body === undefined
          ? {}
          : { contentType: input.contentType ?? "application/json", length: input.body.length }),
      },
      authorized,
    );
    const outgoing = request(
      {
        host: connection.host,
        port: connection.port,
        method: input.method,
        path: input.path,
        headers,
        signal,
      },
      resolve,
    );
    outgoing.once("error", reject);
    outgoing.end(input.body);
  });
}

async function readCapped(
  response: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBytes) {
      response.destroy();
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function answer(response: IncomingMessage, maxBytes: number): Promise<SpadeAnswer> {
  const body = await readCapped(response, maxBytes);
  if (body === undefined) return { kind: "too_large" };
  const contentType = response.headers["content-type"];
  return { kind: "response", status: response.statusCode ?? 502, body, contentType };
}

/** One request to Spade's API; the answer comes back as bytes, uninterpreted. */
export async function spadeRequest(
  connection: SpadeConnection,
  input: { method: string; path: string; body?: Buffer | undefined; contentType?: string },
  options: { signal: AbortSignal; maxBytes: number },
): Promise<SpadeAnswer> {
  return answer(await send(connection, input, options.signal), options.maxBytes);
}

/** A request whose body is streamed to Spade in pieces, with chunked transfer. */
export interface SpadeUpload {
  /** Resolves once Spade can take more. */
  write(piece: Buffer): Promise<void>;
  /** Ends the body and reads Spade's answer. */
  finish(maxBytes: number): Promise<SpadeAnswer>;
}
export function spadeUpload(
  connection: SpadeConnection,
  input: { method: string; path: string; contentType?: string | undefined },
  signal: AbortSignal,
): SpadeUpload {
  const headers = headersFor(
    connection,
    { contentType: input.contentType ?? "application/json" },
    true,
  );
  const responded = Promise.withResolvers<IncomingMessage>();
  const outgoing = request(
    {
      host: connection.host,
      port: connection.port,
      method: input.method,
      path: input.path,
      headers,
      signal,
    },
    responded.resolve,
  );
  outgoing.once("error", responded.reject);
  // A failure before `finish` is read there; never an unhandled rejection.
  responded.promise.catch(() => {});
  return {
    write: (piece) =>
      new Promise((resolve, reject) => {
        if (outgoing.destroyed) return reject(new Error("Spade closed the upload"));
        if (outgoing.write(piece)) return resolve();
        outgoing.once("drain", resolve);
        outgoing.once("close", resolve);
      }),
    async finish(maxBytes) {
      outgoing.end();
      return answer(await responded.promise, maxBytes);
    },
  };
}

/** `GET /health` answers `{"ok":true}` once Spade serves requests. It needs no token. */
export async function spadeHealthy(
  connection: Omit<SpadeConnection, "token">,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await send(
      { ...connection, token: "" },
      { method: "GET", path: "/health" },
      signal,
      false,
    );
    const body = await readCapped(response, 4096);
    if (response.statusCode !== 200 || body === undefined) return false;
    const value: unknown = JSON.parse(body.toString("utf8"));
    return typeof value === "object" && value !== null && Reflect.get(value, "ok") === true;
  } catch {
    return false;
  }
}

export type LiveEnd =
  | { kind: "closed" }
  | { kind: "refused"; status: number }
  | { kind: "too_large" }
  | { kind: "aborted" };
/**
 * Opens a Spade server-sent event stream and hands each event to `onEvent` until Spade closes
 * it or `signal` aborts. Never rejects: every way the stream can end is a `LiveEnd`.
 */
export async function spadeLive(
  connection: SpadeConnection,
  path: string,
  options: { signal: AbortSignal; maxEventChars: number; onEvent(event: SseEvent): void },
): Promise<LiveEnd> {
  let response: IncomingMessage;
  try {
    response = await send(
      connection,
      { method: "GET", path, accept: "text/event-stream" },
      options.signal,
    );
  } catch {
    return options.signal.aborted ? { kind: "aborted" } : { kind: "closed" };
  }
  if (response.statusCode !== 200) {
    response.resume();
    return { kind: "refused", status: response.statusCode ?? 502 };
  }
  const decoder = sseDecoder(options.maxEventChars);
  response.setEncoding("utf8");
  try {
    for await (const chunk of response) {
      for (const event of decoder.push(String(chunk))) options.onEvent(event);
    }
  } catch (error) {
    response.destroy();
    if (error instanceof SseTooLarge) return { kind: "too_large" };
    return options.signal.aborted ? { kind: "aborted" } : { kind: "closed" };
  }
  return options.signal.aborted ? { kind: "aborted" } : { kind: "closed" };
}
