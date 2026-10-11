import { SocketTicket } from "@ace/protocol";
import type { z } from "zod";
import { accessHttp, type AccessOptions } from "./access-http.ts";

/** Exchange one paired credential without loading device-management operations. */
export async function accessTicket(
  options: AccessOptions,
  signal?: AbortSignal,
): Promise<z.infer<typeof SocketTicket>> {
  return SocketTicket.parse(
    await accessHttp(options)("/v1/tickets", "POST", undefined, true, signal),
  );
}
