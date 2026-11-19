import type { MachineCode, MachineCodeResult } from "@ace/protocol";
import type { z } from "zod";
import type { ClientApi } from "./api.ts";
import type { RequestOptions } from "./types.ts";

/**
 * Read, set and clear a machine's code (ADR 0111) over its own connection, with
 * `machine.code.*` requests. Admin only: a device without admin gets `{ ok: false, error:
 * "forbidden" }`. Works on any connected machine, direct, paired-through-relay or account.
 */
export function machineCodeAdmin(client: Pick<ClientApi, "request">) {
  const call = async (
    request:
      | { type: "machine.code.status" }
      | { type: "machine.code.set"; code: z.infer<typeof MachineCode> }
      | { type: "machine.code.clear" },
    options?: RequestOptions,
  ): Promise<MachineCodeResult["result"]> => (await client.request(request, options)).result;
  return {
    status: (options?: RequestOptions) => call({ type: "machine.code.status" }, options),
    set: (code: string, options?: RequestOptions) =>
      call({ type: "machine.code.set", code }, options),
    clear: (options?: RequestOptions) => call({ type: "machine.code.clear" }, options),
  };
}
export type MachineCodeAdmin = ReturnType<typeof machineCodeAdmin>;
