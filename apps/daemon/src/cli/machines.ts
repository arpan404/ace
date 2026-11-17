import type { Client } from "@ace/client";
import type { Args } from "./args.ts";
import { emit } from "./io.ts";
import { machineListLines, machineNames } from "./render/machine.ts";

/**
 * `ace machine list`: this machine's links to the person's other machines (ADR 0078, 0111), each
 * checked once, as the app's Fleet page and the agents' `machines` tool read them.
 */
export async function machineList(args: Args, client: Client, signal: AbortSignal) {
  const response = await client.request(
    { type: "fleet.request", operation: { op: "links" } },
    { signal },
  );
  const machines = response.result.kind === "links" ? response.result.links : [];
  return emit(args, { machines }, { human: machineListLines, quiet: machineNames });
}
