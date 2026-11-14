import type { IncomingMessage, ServerResponse } from "node:http";
import { maxMessageBytes, maxSpadeRequestBytes, type Device } from "@ace/protocol";
import type { MachineTarget } from "./target.ts";
import {
  CALL_ENCODINGS,
  COMPRESS_MIN_BYTES,
  compressibleAnswer,
  compressibleOp,
  decodeBody,
  encodeBody,
  pickEncoding,
} from "./call-encoding.ts";

type Listener = (request: IncomingMessage, response: ServerResponse) => void;
/**
 * A delegated task is as long as a message, and a request for Spade's inbox as long as any
 * request to Spade; the call's other fields fit in the rest.
 */
const maxBody = Math.max(maxMessageBytes, maxSpadeRequestBytes) + 64 * 1024;

/** A request body in a coding this build can't read. */
class UnsupportedCoding extends Error {}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const coding = request.headers["content-encoding"];
  if (coding !== undefined && !/^\s*(identity|zstd|deflate)\s*$/i.test(coding))
    throw new UnsupportedCoding("Unsupported content coding");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBody) throw new Error("Request too large");
    chunks.push(buffer);
  }
  // Inflating is capped at the same limit as a body sent as it is.
  return JSON.parse(decodeBody(Buffer.concat(chunks), coding, maxBody).toString());
}

/** The call's op, read only to decide whether its answer may be compressed. */
function opOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const call: unknown = Reflect.get(body, "call");
  if (typeof call !== "object" || call === null) return undefined;
  const op: unknown = Reflect.get(call, "op");
  return typeof op === "string" ? op : undefined;
}

/**
 * `POST /v1/machine-calls` on the paired-device TLS listener: the same pinned key and device
 * token as `/v1/tickets`, so no new trust channel. Every request authenticates again, so a
 * revoked device or a turned-off opt-in stops the next call.
 */
export function machineCallsHttp(
  target: () => Pick<MachineTarget, "handle"> | undefined,
  authenticate: (token: string) => Device | undefined,
  next: Listener,
): Listener {
  return (request, response) => {
    if (request.url !== "/v1/machine-calls") {
      next(request, response);
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    // The codings this machine reads in request bodies (RFC 7694), told to callers that offer
    // compression themselves; a caller learns from its absence that a machine was downgraded.
    if (request.headers["accept-encoding"] !== undefined)
      response.setHeader("Accept-Encoding", CALL_ENCODINGS);
    let op: string | undefined;
    const reply = (status: number, body: unknown) => {
      if (response.writableEnded) return;
      response.statusCode = status;
      const text = Buffer.from(JSON.stringify(body));
      // Decided per answer: only one holding nothing but fields known to be safe.
      const encoding =
        op !== undefined && text.length >= COMPRESS_MIN_BYTES && compressibleAnswer(op, body)
          ? pickEncoding(request.headers["accept-encoding"])
          : undefined;
      if (!encoding) {
        response.end(text);
        return;
      }
      response.setHeader("Content-Encoding", encoding);
      response.end(encodeBody(text, encoding));
    };
    if (request.method !== "POST") {
      request.resume();
      reply(405, { error: "invalid" });
      return;
    }
    const token = request.headers.authorization?.match(/^Bearer ([0-9a-f]{64})$/)?.[1] ?? "";
    const device = token ? authenticate(token) : undefined;
    const owner = target();
    if (!device) {
      request.resume();
      reply(401, { error: "unauthorized" });
      return;
    }
    if (!owner) {
      request.resume();
      reply(503, { error: "unavailable" });
      return;
    }
    const lifetime = new AbortController();
    response.once("close", () => lifetime.abort());
    void (async () => {
      let body: unknown;
      try {
        body = await readBody(request);
      } catch (error) {
        reply(error instanceof UnsupportedCoding ? 415 : 400, { error: "invalid" });
        return;
      }
      const called = opOf(body);
      op = called !== undefined && compressibleOp(called) ? called : undefined;
      const answer = await owner.handle(device, body, lifetime.signal);
      reply(answer.status, answer.body);
    })().catch(() => reply(500, { error: "unavailable" }));
  };
}
