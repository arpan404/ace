/*
 * This window's own daemon's ace account and machine code (ADR 0111): read from `GET /v1/status`
 * (`remoteAccess.account`), changed through `PUT`/`DELETE /v1/ace-account` and
 * `/v1/machine-code`. The desktop app goes through its main process, which holds the daemon's
 * own credential; a browser calls the daemon's routes itself.
 */
import { MachineAccountStatus, type RemoteAccessStatus } from "@ace/protocol";
import { z } from "zod";
import type { DaemonEndpoint } from "@/boot/connection.tsx";
import { machineAccountBridge, type MachineAccountRequest } from "@/boot/machine-account-bridge.ts";
import type { MachineAccountAccess } from "@/features/ace-account/index.ts";
import { accessOptions } from "./access-source.ts";

const Failure = z.object({ error: z.string().max(256) });

/** A refused change, in words a person can act on. */
function refusal(status: number, said: string | undefined): Error {
  if (status === 403 && said === "Host token required")
    return new Error(
      "Only this computer can sign itself in or out. Use the ace app on it, or `ace login`.",
    );
  if (status === 401 || status === 403)
    return new Error("This device can't change this machine's account settings.");
  if (status === 503) return new Error("ace accounts aren't set up on this machine.");
  return new Error(said ?? "This machine refused the change. Try again.");
}

function daemonRoutes(endpoint: DaemonEndpoint) {
  const options = accessOptions(endpoint);
  return async (request: MachineAccountRequest & { token?: string }) => {
    const path =
      request.op === "setCode" || request.op === "clearCode"
        ? "/v1/machine-code"
        : "/v1/ace-account";
    const body =
      request.op === "setCode"
        ? { code: request.code }
        : request.op === "signIn"
          ? { origin: request.origin, token: request.token }
          : undefined;
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

/** The account controls for the daemon this window runs against. */
export function machineAccountSource(
  endpoint: DaemonEndpoint | undefined,
  remoteStatus: () => Promise<RemoteAccessStatus>,
  scope: object = globalThis,
): MachineAccountAccess {
  const bridge = machineAccountBridge(scope);
  const routes = endpoint && daemonRoutes(endpoint);
  const change = async (request: MachineAccountRequest & { token?: string }) => {
    if (bridge) {
      const { token: _token, ...ask } = request;
      return bridge(ask);
    }
    if (!routes) throw new Error("Connect to your computer first.");
    return routes(request);
  };
  return {
    status: async () => (await remoteStatus()).account,
    signIn: (origin, token) => change({ op: "signIn", origin, token }),
    signOut: () => change({ op: "signOut" }),
    setCode: (code) => change({ op: "setCode", code }),
    clearCode: () => change({ op: "clearCode" }),
  };
}
