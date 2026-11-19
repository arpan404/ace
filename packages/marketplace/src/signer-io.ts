import type { MarketKeySet, SignerPending, Withdrawal } from "@ace/protocol/marketplace";
import { signWithdrawn, verifyWithdrawn, withdrawalKey, type MarketSigningKey } from "./signing.ts";

/* The signer's I/O and the pieces its commands share (ADR 0168 §6, ADR 0174 §10). */

export interface SignerIo {
  /** GET a signer or read route; parsed JSON. */
  get(path: string): Promise<unknown>;
  /** The archive the Worker stored under `hash`, listed or not. */
  object(hash: string): Promise<Uint8Array>;
  /** PUT JSON to a signer route; resolves with the status and body text. */
  put(path: string, body: unknown): Promise<{ status: number; text: string }>;
}

export const label = (version: { type: string; name: string; version: string }) =>
  `${version.type}/${version.name}@${version.version}`;
export const versionPath = (
  route: string,
  version: { type: string; name: string; version: string },
) =>
  `/v1/signer/${route}/${encodeURIComponent(version.type)}/${encodeURIComponent(version.name)}/${encodeURIComponent(version.version)}`;

/** Signs the stored list with `added` appended (each once) and uploads it. */
export async function addWithdrawals(
  io: SignerIo,
  key: MarketSigningKey,
  now: () => number,
  trusted: MarketKeySet,
  pending: SignerPending,
  added: readonly Withdrawal[],
): Promise<{ status: number; text: string; added: number }> {
  // The list may be the previous key's: what counts is that a trusted key signed it.
  const stored = pending.withdrawn ? verifyWithdrawn(pending.withdrawn, trusted) : undefined;
  const earlier = stored?.withdrawn ?? [];
  const known = new Set(earlier.map(withdrawalKey));
  const fresh = added.filter((entry) => !known.has(withdrawalKey(entry)));
  const list = signWithdrawn(
    {
      format: "ace-market-withdrawn",
      issued: now(),
      withdrawn: [...earlier, ...fresh],
      key: key.id,
    },
    key,
  );
  // Based on the list read, so a withdrawal another maintainer added meanwhile is never lost.
  const body = { withdrawn: list, ...(stored ? { basedOn: stored.issued } : {}) };
  return { ...(await io.put("/v1/signer/withdrawn", body)), added: fresh.length };
}
