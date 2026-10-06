import { createServer, connect } from "node:net";
import { z } from "zod";
import type { MutationLease } from "@ace/provider-kit/cleanup";

type Owner = NonNullable<MutationLease["owner"]>;
type Schedule = (callback: () => void, milliseconds: number) => () => void;
const Query = z.object({ token: z.uuid(), id: z.uuid() });
const Reply = z.enum(["active", "quarantined", "unknown"]);
let owner: Promise<Owner> | undefined;
function noop() {}

/** One unreferenced local ownership endpoint per process, created only on Git use. */
export function leaseOwner(
  id: () => string,
  state: (id: string) => "active" | "quarantined" | "unknown",
): Promise<Owner> {
  owner ??= new Promise((resolve, reject) => {
    const token = z.uuid().parse(id());
    const server = createServer((socket) => {
      socket.unref();
      socket.setTimeout(1000, () => socket.destroy());
      let input = "";
      socket.on("error", () => {});
      socket.on("data", (bytes: Buffer) => {
        input += bytes.toString();
        if (input.length > 512) {
          socket.destroy();
          return;
        }
        if (!input.endsWith("\n")) return;
        try {
          const query = Query.parse(JSON.parse(input));
          socket.end(query.token === token ? state(query.id) : "unknown");
        } catch {
          socket.end("unknown");
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("No lease owner endpoint"));
        return;
      }
      server.unref();
      resolve({ port: address.port, token });
    });
  });
  return owner;
}

/** Liveness only, never cleanup proof. Reused ports cannot answer a different token. */
export function queryLeaseOwner(
  lease: MutationLease,
  schedule: Schedule,
): Promise<z.infer<typeof Reply>> {
  if (!lease.owner) return Promise.resolve("unknown");
  const endpoint = lease.owner;
  return new Promise((resolve) => {
    const socket = connect(endpoint.port, "127.0.0.1");
    let input = "";
    let done = false;
    let cancel = noop;
    const finish = (reply: z.infer<typeof Reply>) => {
      if (done) return;
      done = true;
      cancel();
      socket.destroy();
      resolve(reply);
    };
    cancel = schedule(() => finish("unknown"), 1000);
    socket.once("connect", () =>
      socket.end(JSON.stringify({ token: endpoint.token, id: lease.id }) + "\n"),
    );
    socket.on("error", () => finish("unknown"));
    socket.on("data", (bytes: Buffer) => {
      input += bytes.toString();
      if (input.length > 32) finish("unknown");
    });
    socket.once("end", () => {
      const result = Reply.safeParse(input);
      finish(result.success ? result.data : "unknown");
    });
    socket.once("close", () => finish("unknown"));
  });
}
