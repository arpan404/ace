import { DaemonHealth } from "@ace/protocol";
import { accessRequest } from "../client-access.ts";
import { hostConnection } from "./connection.ts";
import type { Health } from "./render/daemon.ts";

/**
 * The local daemon's health from its `/v1/status`, or `{running: false}` when none runs for
 * this home. The remote, remote-access and service facts the health schema doesn't name are
 * kept, so `--json` stays a superset of what older CLIs printed.
 */
export async function daemonHealth(home: string): Promise<Health> {
  try {
    const { origin, token } = hostConnection(home);
    return DaemonHealth.loose().parse(await accessRequest(origin, "/v1/status", { token }));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ECONNREFUSED"].includes(String(error.code))
    )
      return { running: false };
    throw error;
  }
}
