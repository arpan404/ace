import { ClientError, type ClientCore } from "@ace/client";
import { marketCallBody, marketIntent, personMarketCall } from "@ace/client/market-intent";
import type { MarketPublishAction, MarketResult } from "@ace/protocol/marketplace";
import {
  MarketEntryName,
  MarketEntryType,
  MarketOrgId,
  MarketVersion,
} from "@ace/protocol/marketplace";
import { MarketFailure, registryFailure, registryVersionRow } from "@ace/ui-core/market";
import { z } from "zod";

/*
 * Settings › Organization › Registry on the iPhone (ADR 0206 amendment 5). Swift mints the
 * person's grant for one market request on the account backend itself, as for every org call
 * (amendment 4); the bridge names that request (`registryIntent`, with the builder web and the
 * daemon use, so all three name the same bytes) and sends the read or the withdrawal through
 * this machine's daemon with the grant. Each version comes back in the registry's words.
 */

const Grant = z.string().min(1).max(4096);
const Withdrawal = z.object({
  type: MarketEntryType,
  name: MarketEntryName,
  version: MarketVersion,
  reason: z.string().trim().min(1).max(500),
});

export const registryOperations = [
  /** The `action` the person's grant must name: the read, or the withdrawal of one version. */
  z.object({ op: z.literal("registryIntent"), org: MarketOrgId, withdraw: Withdrawal.optional() }),
  z.object({ op: z.literal("registry"), org: MarketOrgId, grant: Grant }),
  z.object({
    op: z.literal("registryWithdraw"),
    org: MarketOrgId,
    grant: Grant,
    ...Withdrawal.shape,
  }),
] as const;

type Operation = z.infer<(typeof registryOperations)[number]>;

/** One version as the phone's row shows it. */
export interface RegistryRow {
  version: string;
  /** "Live · Scan passed". */
  line: string;
  detail?: string;
  canWithdraw: boolean;
}

export type RegistryAnswer =
  | { ok: true; intent: string }
  | { ok: true; entries: { type: string; name: string; title: string; versions: RegistryRow[] }[] }
  | { ok: true }
  | { ok: false; message: string };

function actionOf(operation: Operation): MarketPublishAction {
  if (operation.op === "registry") return { action: "registry", org: operation.org };
  if (operation.op === "registryWithdraw") {
    const { op: _op, grant: _grant, ...withdrawal } = operation;
    return { action: "registryWithdraw", ...withdrawal };
  }
  return operation.withdraw
    ? { action: "registryWithdraw", org: operation.org, ...operation.withdraw }
    : { action: "registry", org: operation.org };
}

const refused = (error: unknown) => ({ ok: false as const, message: registryFailure(error) });

export async function answerRegistry(
  owner: Pick<ClientCore, "request">,
  operation: Operation,
  signal?: AbortSignal,
): Promise<RegistryAnswer> {
  const action = actionOf(operation);
  if (operation.op === "registryIntent") {
    const call = personMarketCall(action);
    if (!call) return refused(undefined);
    const body = marketCallBody(call);
    return { ok: true, intent: await marketIntent({ method: call.method, path: call.path, body }) };
  }
  let result: MarketResult;
  try {
    ({ result } = await owner.request(
      {
        type: "marketplace.request",
        operation: { op: "publish", request: action },
        personGrant: operation.grant,
      },
      signal ? { signal } : {},
    ));
  } catch (error) {
    if (error instanceof ClientError && error.code !== "aborted")
      return refused(new MarketFailure("unavailable"));
    throw error;
  }
  if (result.op === "error") return refused(new MarketFailure(result.code));
  if (result.op !== "publish") return refused(undefined);
  const answer = result.answer;
  if (operation.op === "registryWithdraw")
    return answer.kind === "pending" ? { ok: true } : refused(undefined);
  if (answer.kind !== "registry") return refused(undefined);
  return {
    ok: true,
    entries: answer.registry.entries.map((entry) => ({
      type: entry.type,
      name: entry.name,
      title: entry.title,
      versions: entry.versions.map((version) => {
        const row = registryVersionRow(version);
        return {
          version: version.version,
          line: `${row.state} · ${row.scan}`,
          ...(row.detail ? { detail: row.detail } : {}),
          canWithdraw: row.canWithdraw,
        };
      }),
    })),
  };
}
