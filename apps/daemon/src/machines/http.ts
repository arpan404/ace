import type { IncomingMessage, ServerResponse } from "node:http";
import type { Device } from "@ace/protocol";
import type { MachineTarget } from "./target.ts";

type Listener = (request: IncomingMessage, response: ServerResponse) => void;
const maxBody = 64 * 1024;

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBody) throw new Error("Request too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

/**
 * `POST /v1/machine-calls` on the paired-device TLS listener: the same pinned key and device
 * token as `/v1/tickets`, so no new trust channel. Every request authenticates again, so a
 * revoked device or a turned-off opt-in stops the next call.
 */
export function machineCallsHttp(
  target: () => MachineTarget | undefined,
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
    const reply = (status: number, body: unknown) => {
      if (response.writableEnded) return;
      response.statusCode = status;
      response.end(JSON.stringify(body));
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
      } catch {
        reply(400, { error: "invalid" });
        return;
      }
      const answer = await owner.handle(device, body, lifetime.signal);
      reply(answer.status, answer.body);
    })().catch(() => reply(500, { error: "unavailable" }));
  };
}
