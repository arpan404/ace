import { MachineAccountStatus } from "@ace/protocol";
import { z } from "zod";
import type { MachineAccountRequest } from "../shared/channels.ts";
import type { DaemonConnection } from "../shared/contract.ts";

const Failure = z.object({ error: z.string().max(256) });

/**
 * Signs this computer's daemon in or out of the app's ace account and sets or clears its
 * machine code, with the app's host credential. The renderer can't call these routes itself:
 * the daemon serves them to its own credential and same-origin callers only. Signing in uses the
 * session the app saved, so the renderer never hands the token over again; a remote daemon is
 * never given it.
 */
export async function machineAccount(
  connection: DaemonConnection,
  request: MachineAccountRequest,
  savedSession: (origin: string) => Promise<string | null>,
  send: typeof fetch = fetch,
): Promise<MachineAccountStatus> {
  if (connection.mode !== "daemon") throw new Error("No daemon is running on this computer.");
  const local = connection.localHostId !== undefined;
  if ((request.op === "signIn" || request.op === "signOut") && !local)
    throw new Error("Only a daemon on this computer can be signed in from here.");
  let path = "/v1/ace-account";
  let method = "DELETE";
  let body: unknown;
  if (request.op === "signIn") {
    const token = await savedSession(request.origin);
    if (!token) throw new Error("Sign in to your ace account in this app first.");
    method = "PUT";
    body = { origin: request.origin, token };
  } else if (request.op === "setCode") {
    path = "/v1/machine-code";
    method = "PUT";
    body = { code: request.code };
  } else if (request.op === "clearCode") path = "/v1/machine-code";
  const url = new URL(path, connection.url);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const response = await send(url, {
    method,
    headers: {
      authorization: `Bearer ${connection.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const data: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const failure = Failure.safeParse(data);
    throw new Error(
      failure.success ? failure.data.error : `The daemon refused (${response.status}).`,
    );
  }
  return MachineAccountStatus.parse(data);
}
