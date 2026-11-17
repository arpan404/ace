import { DaemonHealth, MachineAccountStatus } from "@ace/protocol";
import { accessRequest } from "../../client-access.ts";
import { hostConnection } from "../connection.ts";
import type { CommandContext } from "../run/context.ts";
import { statusLines } from "../render/status.ts";
import { show } from "./output.ts";

/** How long `ace status` waits for the extras before printing what it has. */
const extrasTimeout = "3s";

function down(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ECONNREFUSED"].includes(String(error.code))
  );
}

/**
 * `ace status`: the daemon's health exactly as before (or `{running: false}`), plus the ace
 * account, how many requests need the person and how many threads work (ADR 0176 §7). The
 * extras are additive: one the daemon can't give in time is left out, and status never fails
 * because of them.
 */
export async function statusCommand(context: CommandContext): Promise<void> {
  const home = context.config().dataDir;
  let health: Record<string, unknown> & { version?: string };
  let origin: string;
  let token: string;
  try {
    ({ origin, token } = hostConnection(home));
    health = DaemonHealth.loose().parse(await accessRequest(origin, "/v1/status", { token }));
  } catch (error) {
    if (!down(error)) throw error;
    return show(
      context.args,
      { running: false as const },
      { human: () => statusLines({ running: false }), quiet: () => [] },
    );
  }
  const [account, counts] = await Promise.all([
    accessRequest(origin, "/v1/ace-account", { token })
      .then((value) => MachineAccountStatus.parse(value))
      .then((status) => ({
        signedIn: status.signedIn,
        ...(status.account?.email ? { email: status.account.email } : {}),
      }))
      .catch(() => undefined),
    workCounts(context).catch(() => undefined),
  ]);
  const value = statusJson(health, account, counts);
  await show(context.args, value, {
    human: () =>
      statusLines({
        running: true,
        ...(typeof health.version === "string" ? { version: health.version } : {}),
        ...(account ? { account } : {}),
        ...counts,
      }),
    quiet: () => [],
  });
}

async function workCounts(context: CommandContext) {
  const { connectCli } = await import("../connection.ts");
  const session = await connectCli(context.config().dataDir, {
    ...context.args,
    flags: { timeout: extrasTimeout },
  });
  const both = session.signal;
  try {
    const { readRequests } = await import("./daemon.ts");
    const { listRows } = await import("./thread-reads.ts");
    const [requests, rows] = await Promise.all([
      readRequests(session.client, both),
      listRows(session.client, both, { want: 1 }),
    ]);
    return {
      needsYou: requests.requests.length,
      working: rows.rows.filter((row) => ["working", "waiting", "background"].includes(row.state))
        .length,
    };
  } finally {
    await session.close();
  }
}

/** `ace status --json` with the daemon up: its health untouched, then the extras it could read. */
export function statusJson<T extends object>(
  health: T,
  account: { signedIn: boolean; email?: string } | undefined,
  counts: { needsYou: number; working: number } | undefined,
) {
  return { ...health, ...(account ? { account } : {}), ...counts };
}
