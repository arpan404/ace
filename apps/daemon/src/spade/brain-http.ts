import type { IncomingMessage, ServerResponse } from "node:http";
import { SpadeBrainTurnRequest, type SpadeBrainFrame } from "@ace/protocol";
import type { SpadeBrains } from "./brain-sessions.ts";

/** The largest turn request: the message cap plus instructions, as JSON. */
const mostRequestBytes = 2 * 1024 * 1024;

export const brainPathPrefix = "/spade/brains/";

export interface BrainHttpOptions {
  brains: Pick<SpadeBrains, "turn" | "subscriptions">;
  /** Whether a bearer is Spade's live grant. */
  verify(bearer: string): boolean;
}

/**
 * `<daemon>/spade/brains/*` on the loopback listener (ADR 0133), for Spade with its grant:
 * `GET subscriptions` and `POST turn`, whose answer is JSON lines until the turn ends. Spade
 * closing the request interrupts the turn.
 */
export function brainHttp(options: BrainHttpOptions) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (!bearer || !options.verify(bearer)) return answer(response, 401, { error: "unauthorized" });
    const path = (request.url ?? "/").split("?")[0];
    if (path === `${brainPathPrefix}subscriptions` && request.method === "GET")
      return answer(response, 200, options.brains.subscriptions());
    if (path === `${brainPathPrefix}turn` && request.method === "POST")
      return void turn(options, request, response);
    answer(response, 404, { error: "not found" });
  };
}

async function turn(options: BrainHttpOptions, request: IncomingMessage, response: ServerResponse) {
  const body = await readBody(request);
  if (body === undefined) return answer(response, 413, { error: "too large" });
  let parsed: SpadeBrainTurnRequest;
  try {
    parsed = SpadeBrainTurnRequest.parse(JSON.parse(body));
  } catch {
    return answer(response, 400, { error: "invalid turn" });
  }
  const lifetime = new AbortController();
  // Spade going away (Stop, a pause, a restart) is the only way a turn is cut short.
  response.on("close", () => {
    if (!response.writableFinished) lifetime.abort();
  });
  response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  const emit = (frame: SpadeBrainFrame) => {
    if (!response.destroyed) response.write(`${JSON.stringify(frame)}\n`);
  };
  try {
    await options.brains.turn(parsed, lifetime.signal, emit);
  } catch (error) {
    emit({
      type: "failed",
      reason: "failed",
      message: error instanceof Error ? error.message.slice(0, 300) : "The turn failed.",
    });
  }
  response.end();
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > mostRequestBytes) {
        resolve(undefined);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(undefined));
  });
}

function answer(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
