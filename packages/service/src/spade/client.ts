import { request, type IncomingMessage } from "node:http";
import { checkSpadeProof, isSpadeNonce } from "./proof.ts";
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
    headers?: Readonly<Record<string, string>> | undefined;
  },
  signal: AbortSignal,
  authorized = true,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const headers = {
      ...input.headers,
      ...headersFor(
        connection,
        {
          ...(input.accept ? { accept: input.accept } : {}),
          ...(input.body === undefined
            ? {}
            : { contentType: input.contentType ?? "application/json", length: input.body.length }),
        },
        authorized,
      ),
    };
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

/**
 * One request to Spade's API; the answer comes back as bytes, uninterpreted. `headers` are the
 * daemon's own (never a client's); the token, accept and body headers always win over them.
 */
export async function spadeRequest(
  connection: SpadeConnection,
  input: {
    method: string;
    path: string;
    body?: Buffer | undefined;
    contentType?: string;
    headers?: Readonly<Record<string, string>>;
  },
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

/** Errors that mean the request never reached Spade: nothing was listening at its address. */
const unconnected = new Set(["ECONNREFUSED", "ENOENT", "EADDRNOTAVAIL", "EHOSTUNREACH"]);

/**
 * Whether a failed request certainly never reached Spade, so sending it another way can't do
 * it twice. A reset or a timeout after connecting may have reached it.
 */
export function neverConnected(error: unknown): boolean {
  const code: unknown =
    typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" && unconnected.has(code);
}

/** What `GET /health` says when Spade serves requests. */
export interface SpadeHealth {
  version: string | undefined;
  /** Spade's HTTP API version; absent from builds older than ADR 0123. */
  api: number | undefined;
  /** Spade's proof for the nonce asked with, if one was. */
  proof: string | undefined;
}

/**
 * `GET /health` answers `{"ok":true,"version":…,"api":…}` once Spade serves requests. It needs
 * no token. Undefined: Spade isn't serving (nothing listens, or it answered otherwise).
 */
export async function spadeHealth(
  connection: Omit<SpadeConnection, "token">,
  signal: AbortSignal,
  nonce?: string,
): Promise<SpadeHealth | undefined> {
  if (nonce !== undefined && !isSpadeNonce(nonce)) return undefined;
  try {
    const response = await send(
      { ...connection, token: "" },
      { method: "GET", path: nonce === undefined ? "/health" : `/health?nonce=${nonce}` },
      signal,
      false,
    );
    const body = await readCapped(response, 4096);
    if (response.statusCode !== 200 || body === undefined) return undefined;
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (typeof value !== "object" || value === null || Reflect.get(value, "ok") !== true)
      return undefined;
    const version: unknown = Reflect.get(value, "version");
    const api: unknown = Reflect.get(value, "api");
    const proof: unknown = Reflect.get(value, "proof");
    return {
      version: typeof version === "string" ? version.slice(0, 64) : undefined,
      api: typeof api === "number" && Number.isInteger(api) ? api : undefined,
      proof: typeof proof === "string" ? proof.slice(0, 128) : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Spade's health, only from the Spade that holds `connection.token`: `/health` with `nonce` (a
 * fresh one per check, `newSpadeNonce`) must answer the right proof. Undefined otherwise, and
 * then the token must not be sent to that address. The check itself never sends the token.
 */
export async function proveSpade(
  connection: SpadeConnection,
  nonce: string,
  signal: AbortSignal,
): Promise<SpadeHealth | undefined> {
  const health = await spadeHealth(connection, signal, nonce);
  return health && checkSpadeProof(connection.token, nonce, health.proof) ? health : undefined;
}

/** Whether Spade serves requests (`spadeHealth` answered). */
export async function spadeHealthy(
  connection: Omit<SpadeConnection, "token">,
  signal: AbortSignal,
): Promise<boolean> {
  return (await spadeHealth(connection, signal)) !== undefined;
}

export type LiveEnd =
  | { kind: "closed" }
  /** Nothing listened at Spade's address: the stream never opened. */
  | { kind: "unreachable" }
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
  } catch (error) {
    if (options.signal.aborted) return { kind: "aborted" };
    return neverConnected(error) ? { kind: "unreachable" } : { kind: "closed" };
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
