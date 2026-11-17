import {
  MarketQueueBody,
  PublisherVersionsBody,
  SignerPending,
  type MarketBlocklist,
  type MarketKeySet,
  type MarketOfficialList,
  type MarketPublisher,
  type MarketVerifiedList,
  type Withdrawal,
} from "@ace/protocol/marketplace";
import { sha256Hex } from "./hash.ts";
import {
  signBlocklist,
  signOfficialList,
  signVerifiedList,
  verifyBlocklist,
  verifyOfficialList,
  verifyVerifiedList,
  type MarketSigningKey,
} from "./signing.ts";
import { addWithdrawals, type SignerIo } from "./signer-io.ts";

/*
 * The maintainers' signed lists (ADR 0173 §8, §10, §13, §14): each command reads the list as
 * last signed (checked against the trusted keys, so a rotation keeps working), changes it, signs
 * it whole with a newer `issued` and uploads it with the `issued` it read; when another
 * maintainer's edit landed in between the Worker answers 409 and the command is run again. Revoking every live version of a publisher signs
 * them into the withdrawn list.
 */

type Answer = { status: number; text: string };
const pendingOf = async (io: SignerIo) => SignerPending.parse(await io.get("/v1/signer/pending"));
const encoder = new TextEncoder();
/**
 * The list an edit started from, so the Worker stores it only while that list is still the
 * stored one: two maintainers editing at once get a conflict, never a lost change.
 */
const basedOn = (earlier: { issued: number } | undefined) =>
  earlier ? { basedOn: earlier.issued } : {};

export type BlocklistChange =
  | { kind: "hash"; hash: string; reason: string }
  | { kind: "file"; sha256: string; reason: string }
  | { kind: "pattern"; text: string; reason: string };

/** Adds one item to the blocklist (once) and signs it. */
export async function signBlocklistChange(
  io: SignerIo,
  key: MarketSigningKey,
  now: () => number,
  trusted: MarketKeySet,
  change: BlocklistChange,
): Promise<Answer> {
  const pending = await pendingOf(io);
  const earlier: MarketBlocklist | undefined = pending.blocklist
    ? verifyBlocklist(pending.blocklist, trusted)
    : undefined;
  const hashes = [...(earlier?.hashes ?? [])];
  const files = [...(earlier?.files ?? [])];
  const patterns = [...(earlier?.patterns ?? [])];
  if (change.kind === "hash" && !hashes.some((item) => item.hash === change.hash))
    hashes.push({ hash: change.hash, reason: change.reason });
  if (change.kind === "file" && !files.some((item) => item.sha256 === change.sha256))
    files.push({ sha256: change.sha256, reason: change.reason });
  if (change.kind === "pattern") {
    const id = `p-${sha256Hex(encoder.encode(change.text.toLowerCase())).slice(0, 16)}`;
    if (!patterns.some((item) => item.id === id))
      patterns.push({ id, text: change.text, reason: change.reason });
  }
  const blocklist = signBlocklist(
    { format: "ace-market-blocklist", issued: now(), hashes, files, patterns, key: key.id },
    key,
  );
  return io.put("/v1/signer/blocklist", { blocklist, ...basedOn(earlier) });
}

async function publisherNamed(io: SignerIo, handle: string) {
  try {
    return PublisherVersionsBody.safeParse(
      await io.get(`/v1/signer/publishers/${encodeURIComponent(handle)}`),
    ).data;
  } catch {
    // The CLI's reader throws on a 404; a test's answers the error body.
    return undefined;
  }
}

/**
 * Signs `handle` onto the verified list with the proofs its application passed, or off it with
 * the reason the publisher sees.
 */
export async function signVerifiedChange(
  io: SignerIo,
  key: MarketSigningKey,
  now: () => number,
  trusted: MarketKeySet,
  change: { handle: string; verified: boolean; reason: string },
): Promise<Answer> {
  const pending = await pendingOf(io);
  const stored: MarketVerifiedList | undefined = pending.verified
    ? verifyVerifiedList(pending.verified, trusted)
    : undefined;
  const earlier = stored?.publishers ?? [];
  const others = earlier.filter((entry) => entry.handle !== change.handle);
  let publishers = others;
  if (change.verified) {
    const found = await publisherNamed(io, change.handle);
    if (!found) return { status: 404, text: `No publisher is called ${change.handle}` };
    const queue = MarketQueueBody.parse(await io.get("/v1/signer/queue"));
    const applied = queue.verifications.find((item) => item.publisher.id === found.publisher.id);
    const before = earlier.find((entry) => entry.id === found.publisher.id);
    const proofs = applied?.proofs ?? before?.proofs ?? [{ kind: "account" as const }];
    publishers = [
      ...others,
      { id: found.publisher.id, handle: found.publisher.name, proofs, at: now() },
    ];
  } else if (others.length === earlier.length)
    return { status: 404, text: `${change.handle} isn't on the verified list` };
  const verified = signVerifiedList(
    { format: "ace-market-verified", issued: now(), publishers, key: key.id },
    key,
  );
  return io.put("/v1/signer/verified", {
    verified,
    ...basedOn(stored),
    revoked: change.verified ? [] : [{ handle: change.handle, reason: change.reason }],
  });
}

/**
 * Adds or removes an account on the official list, signed with the `ace` publisher's id: the
 * list's own, else the market's `ace` publisher, else a new id the Worker makes `ace` from.
 */
export async function signOfficialChange(
  io: SignerIo,
  key: MarketSigningKey,
  now: () => number,
  trusted: MarketKeySet,
  change: { account: string; add: boolean },
  newId: () => string,
): Promise<Answer> {
  const pending = await pendingOf(io);
  const earlier: MarketOfficialList | undefined = pending.official
    ? verifyOfficialList(pending.official, trusted)
    : undefined;
  const publisher: MarketPublisher = earlier?.publisher ??
    (await publisherNamed(io, "ace"))?.publisher ?? { id: newId(), name: "ace" };
  const others = (earlier?.accounts ?? []).filter((account) => account !== change.account);
  if (!change.add && others.length === (earlier?.accounts.length ?? 0))
    return { status: 404, text: `${change.account} isn't on the official list` };
  const official = signOfficialList(
    {
      format: "ace-market-official",
      issued: now(),
      publisher,
      accounts: change.add ? [...others, change.account] : others,
      key: key.id,
    },
    key,
  );
  return io.put("/v1/signer/official", { official, ...basedOn(earlier) });
}

/** Signs every live version of a publisher into the withdrawn list, with the maintainer's reason. */
export async function signWithdrawAll(
  io: SignerIo,
  key: MarketSigningKey,
  now: () => number,
  trusted: MarketKeySet,
  target: { handle: string; reason: string },
): Promise<Answer & { added: number }> {
  const found = await publisherNamed(io, target.handle);
  if (!found) return { status: 404, text: `No publisher is called ${target.handle}`, added: 0 };
  if (found.live.length === 0) return { status: 200, text: "Nothing is live", added: 0 };
  const at = now();
  return addWithdrawals(
    io,
    key,
    now,
    trusted,
    await pendingOf(io),
    found.live.map((version): Withdrawal => ({
      scope: "version",
      type: version.type,
      name: version.name,
      version: version.version,
      hash: version.hash,
      reason: target.reason,
      at,
    })),
  );
}
