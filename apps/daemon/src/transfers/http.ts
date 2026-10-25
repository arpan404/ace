import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HostId,
  MachineTransferCall,
  TransferKey,
  transferChunkBytes,
  type Device,
  type TransferProbe,
} from "@ace/protocol";
import { allows } from "../devices.ts";
import { TargetRefusal } from "../machines/target-refusal.ts";
import type { IncomingTransfers } from "./incoming.ts";

type Listener = (request: IncomingMessage, response: ServerResponse) => void;

export interface TransferTarget {
  incoming: IncomingTransfers;
  hostId: string;
  hostName(): Promise<string>;
  log(message: string, fields: Record<string, unknown>): void;
}

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

/** Transfers are the person's or their agents' moves of work, so they need both scopes. */
function assertMayTransfer(device: Device): void {
  if (!allows(device, "operate") || !allows(device, "projects"))
    throw new TargetRefusal(
      "machine_forbidden",
      "This machine's link doesn't allow moving projects here. Link the machines again with Projects allowed.",
    );
}

/**
 * `POST /v1/transfers` and `PUT /v1/transfers/chunk` on the paired-device TLS listener
 * (ADR 0101): the same pinned key and device token as `/v1/machine-calls`. Every request
 * authenticates again; `remote.agentAccess` does not apply to transfers.
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
    const owner = target();
    if (request.method !== method || !device || !owner) {
      request.resume();
      reply(request.method !== method ? 405 : !device ? 401 : 503, {
        error: request.method !== method ? "invalid" : !device ? "unauthorized" : "unavailable",
      });
      return;
    }
    void (async () => {
      try {
        if (route === "chunk") {
          assertMayTransfer(device);
          const transferId = TransferKey.parse(url.searchParams.get("transfer"));
          const offset = Number(url.searchParams.get("offset"));
          if (!Number.isSafeInteger(offset) || offset < 0)
            throw new TargetRefusal("invalid", "Bad offset.");
          const part = url.searchParams.get("part") ?? "code";
          if (part !== "code" && part !== "ignored")
            throw new TargetRefusal("invalid", "Bad part.");
          const data = await readBody(request, transferChunkBytes);
          reply(200, await owner.incoming.chunk(device, transferId, offset, data, part));
          return;
        }
        const parsed = MachineTransferCall.safeParse(
          JSON.parse((await readBody(request, 1024 * 1024)).toString()),
        );
        if (!parsed.success) throw new TargetRefusal("invalid");
        const call = parsed.data;
        if (call.op === "probe") {
          const probe: TransferProbe = {
            hostId: HostId.parse(owner.hostId),
            name: (await owner.hostName()).slice(0, 256) || "ace",
            accepts: allows(device, "operate") && allows(device, "projects"),
          };
          reply(200, probe);
          return;
        }
        assertMayTransfer(device);
        reply(200, await owner.incoming.call(device, call));
      } catch (error) {
        const refusal =
          error instanceof TargetRefusal
            ? error
            : error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")
              ? new TargetRefusal("invalid")
              : new TargetRefusal("unavailable");
        owner.log("Transfer call from another device refused", {
          device: device.name,
          deviceId: device.id,
          outcome: refusal.code,
        });
        reply(refusal.status, refusal.body());
      }
    })();
  };
}
