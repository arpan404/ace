/*
 * This window's own daemon's ace account and machine code (ADR 0111). The status is the remote
 * access status's `account`, read over the connection. The desktop app changes both through its
 * main process, which holds the daemon's own credential. A browser sets and clears the code over
 * its connection (`machine.code.*`, admin only, as the HTTP route), so it works through a relay
 * too, and signs in and out with `PUT`/`DELETE /v1/ace-account`, which only this computer's own
 * credential may call. A relayed connection has no HTTP route, and its token never goes to the
 * relay's address.
 */
import { MachineAccountStatus, type RemoteAccessStatus } from "@ace/protocol";
import { z } from "zod";
import type { DaemonEndpoint } from "@/boot/connection.tsx";
import { directTarget } from "@/boot/main-machine.ts";
import { machineAccountBridge, type MachineAccountRequest } from "@/boot/machine-account-bridge.ts";
import type { MachineAccountAccess } from "@/features/ace-account/index.ts";
import type { ClientApi } from "@ace/client";
import { accessOptions } from "./access-source.ts";
import { machineCodeAdminSource } from "./machine-code-admin-source.ts";

const Failure = z.object({ error: z.string().max(256) });

/** A refused change, in words a person can act on. */
function refusal(status: number, said: string | undefined): Error {
  if (status === 403 && said === "Host token required") return hostOnly();
  if (status === 401 || status === 403)
    return new Error("This device can't change this machine's account settings.");
  if (status === 503) return new Error("ace accounts aren't set up on this machine.");
  return new Error(said ?? "This machine refused the change. Try again.");
}

type AccountRequest = Extract<MachineAccountRequest, { op: "signIn" | "signOut" }> & {
  token?: string;
};

const hostOnly = () =>
  new Error("Only this computer can sign itself in or out. Use the ace app on it, or `ace login`.");

function daemonRoutes(endpoint: DaemonEndpoint) {
  // Reached only through a relay (a self-hosted one, or ace's for a machine on the account): its
  // address is the relay's, never the daemon's.
  if (endpoint.kind === "account" || (endpoint.kind === "daemon" && !directTarget(endpoint)))
    return () => Promise.reject(hostOnly());
  const options = accessOptions(endpoint);
  return async (request: AccountRequest) => {
    const path = "/v1/ace-account";
    const body =
      request.op === "signIn" ? { origin: request.origin, token: request.token } : undefined;
    let response: Response;
    try {
      response = await options.fetch(new URL(path, options.origin).href, {
        method: body ? "PUT" : "DELETE",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${await options.token()}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error("Couldn't reach this machine. Reconnect and try again.");
    }
    const data: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw refusal(response.status, Failure.safeParse(data).data?.error);
    return MachineAccountStatus.parse(data);
  };
}

const offline = () => Promise.reject(new Error("Connect to your computer first."));

/** The account controls for the daemon this window runs against. */
export function machineAccountSource(
  endpoint: DaemonEndpoint | undefined,
  remoteStatus: () => Promise<RemoteAccessStatus>,
  client: Pick<ClientApi, "request"> | undefined,
  scope: object = globalThis,
): MachineAccountAccess {
  const bridge = machineAccountBridge(scope);
  const routes = endpoint && daemonRoutes(endpoint);
  const code = client && machineCodeAdminSource(client);
  const account = async (request: AccountRequest) => {
    if (bridge) {
      const { token: _token, ...ask } = request;
      return bridge(ask);
    }
    if (!routes) throw new Error("Connect to your computer first.");
    return routes(request);
  };
  return {
    status: async () => (await remoteStatus()).account,
    signIn: (origin, token) => account({ op: "signIn", origin, token }),
    signOut: () => account({ op: "signOut" }),
    setCode: (value) =>
      bridge ? bridge({ op: "setCode", code: value }) : code ? code.setCode(value) : offline(),
    clearCode: () => (bridge ? bridge({ op: "clearCode" }) : code ? code.clearCode() : offline()),
  };
}
