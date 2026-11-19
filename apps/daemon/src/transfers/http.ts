import type { IncomingMessage, ServerResponse } from "node:http";
import { MachineTransferCall, TransferKey, transferChunkBytes, type Device } from "@ace/protocol";
import { TargetRefusal } from "../machines/target-refusal.ts";
import { keepTrusted } from "../sni-listener.ts";
import { answerTransfer, refused, type TransferRequest, type TransferTarget } from "./serve.ts";

type Listener = (request: IncomingMessage, response: ServerResponse) => void;

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new TargetRefusal("invalid", "Request too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * `POST /v1/transfers` and `PUT /v1/transfers/chunk` on the paired-device TLS listener
 * (ADR 0101): the same pinned key and device token as `/v1/machine-calls`. Every request
 * authenticates again; `answerTransfer` decides it, as it does for one through a relay.
 */
export function transfersHttp(
  target: () => TransferTarget | undefined,
  authenticate: (token: string) => Device | undefined,
  next: Listener,
): Listener {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "https://ace.invalid");
    const route =
      url.pathname === "/v1/transfers"
        ? "call"
        : url.pathname === "/v1/transfers/chunk"
          ? "chunk"
          : undefined;
    if (!route) {
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
    const method = route === "call" ? "POST" : "PUT";
    const token = request.headers.authorization?.match(/^Bearer ([0-9a-f]{64})$/)?.[1] ?? "";
    const device = token ? authenticate(token) : undefined;
    // A paired machine sending a project keeps its connection open for the next chunk.
    if (device) keepTrusted(request, response);
    const owner = target();
    if (request.method !== method || !device || !owner) {
      request.resume();
      reply(request.method !== method ? 405 : !device ? 401 : 503, {
        error: request.method !== method ? "invalid" : !device ? "unauthorized" : "unavailable",
      });
      return;
    }
    void (async () => {
      let parsed: TransferRequest;
      try {
        parsed = await readRequest(request, url, route);
      } catch (error) {
        const answer = refused(owner, device, error);
        reply(answer.status, answer.body);
        return;
      }
      const answer = await answerTransfer(owner, device, parsed);
      reply(answer.status, answer.body);
    })().catch((error: unknown) =>
      owner.log("Serving a transfer call failed", {
        device: device.name,
        deviceId: device.id,
        error,
      }),
    );
  };
}

/** The call a request carries; a malformed one is refused as invalid. */
async function readRequest(
  request: IncomingMessage,
  url: URL,
  route: "call" | "chunk",
): Promise<TransferRequest> {
  if (route === "call")
    return {
      kind: "call",
      call: MachineTransferCall.parse(
        JSON.parse((await readBody(request, 1024 * 1024)).toString()),
      ),
    };
  const transferId = TransferKey.parse(url.searchParams.get("transfer"));
  const offset = Number(url.searchParams.get("offset"));
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new TargetRefusal("invalid", "Bad offset.");
  const part = url.searchParams.get("part") ?? "code";
  if (part !== "code" && part !== "ignored") throw new TargetRefusal("invalid", "Bad part.");
  return {
    kind: "chunk",
    transferId,
    offset,
    part,
    data: await readBody(request, transferChunkBytes),
  };
}
