import { describe, expect, it } from "vitest";
import { writeArchive } from "./archive.ts";
import { contentHash, hashFiles } from "./hash.ts";
import {
  signBlocklistChange,
  signOfficialChange,
  signPending,
  signReview,
  signVerifiedChange,
  signWithdrawAll,
  type SignerIo,
} from "./signer.ts";
import {
  signBlocklist,
  signOfficialList,
  signVerifiedList,
  verifyBlocklist,
  verifyOfficialList,
  verifyReviewMark,
  verifyVerifiedList,
  verifyWithdrawn,
} from "./signing.ts";
import { keySetOf, sampleSkill, signedVersion, signedWithdrawn, testKey } from "./testing.ts";

/* The signer through its I/O, here an in-memory market. */

const old = testKey("market-1", 1);
const next = testKey("market-2", 2);
const trusted = keySetOf(old, next);

function memory(answers: Record<string, unknown>) {
  const puts: { path: string; body: unknown }[] = [];
  const io: SignerIo = {
    get: async (path) => answers[path],
    object: async () => new Uint8Array(),
    put: async (path, body) => {
      puts.push({ path, body });
      return { status: 200, text: "" };
    },
  };
  return { io, puts };
}

function bodyOf<T>(puts: { body: unknown }[]): T {
  const [first] = puts;
  if (!first) throw new Error("Nothing was uploaded");
  return first.body as T;
}

describe("after the market key rotates", () => {
  it("the signer adds to a withdrawn list the previous key signed", async () => {
    const earlier = signedWithdrawn([{ hash: "a".repeat(64), reason: "Old" }], {
      key: old,
      issued: 10,
    });
    const { io, puts } = memory({
      "/v1/signer/pending": {
        versions: [],
        withdrawals: [
          {
            type: "spade-skill",
            name: "x",
            version: "1.0.0",
            hash: "b".repeat(64),
            reason: "New",
            at: 20,
          },
        ],
        withdrawn: earlier,
      },
    });
    const report = await signPending(io, next, () => 30, trusted);
    expect(report.failed).toEqual([]);
    const list = verifyWithdrawn(bodyOf<{ withdrawn: unknown }>(puts).withdrawn, keySetOf(next));
    expect(list.withdrawn.map((entry) => entry.reason)).toEqual(["Old", "New"]);
  });

  it("a review mark can be signed for a version the previous key signed", async () => {
    const version = signedVersion({
      type: "spade-skill",
      name: "triage-mail",
      files: sampleSkill(),
      key: old,
    });
    const { io, puts } = memory({
      "/v1/entries/spade-skill/triage-mail/1.0.0": { manifest: version.manifest },
    });
    const answer = await signReview(io, next, () => 30, trusted, {
      type: "spade-skill",
      name: "triage-mail",
      version: "1.0.0",
      reviewed: true,
      byAce: false,
    });
    expect(answer.status).toBe(200);
    expect(verifyReviewMark(bodyOf<{ review: unknown }>(puts).review, keySetOf(next)).hash).toBe(
      version.hash,
    );
  });

  it("refuses a list signed by a key outside the trusted set", async () => {
    const stranger = signedWithdrawn([], { key: testKey("market-1", 9), issued: 10 });
    const { io } = memory({
      "/v1/signer/pending": {
        versions: [],
        withdrawals: [
          {
            type: "spade-skill",
            name: "x",
            version: "1.0.0",
            hash: "b".repeat(64),
            reason: "New",
            at: 20,
          },
        ],
        withdrawn: stranger,
      },
    });
    await expect(signPending(io, next, () => 30, trusted)).rejects.toThrow();
  });
});

/* ---------------------------------------------------------------- the re-scan and the lists */

const skill = sampleSkill("rescanned");
const skillHash = contentHash(hashFiles(skill));
const pendingOf = (extra: Record<string, unknown> = {}, version: Record<string, unknown> = {}) => ({
  versions: [
    {
      type: "spade-skill",
      name: "rescanned",
      version: "1.0.0",
      hash: skillHash,
      size: 1,
      published: 1,
      publisher: { id: "pub_someone", name: "someone" },
      ...version,
    },
  ],
  withdrawals: [],
  ...extra,
});
const context = { entries: [], verified: [], newPublishers: [] };

function market(answers: Record<string, unknown>) {
  const made = memory({ "/v1/signer/scan-context": context, ...answers });
  made.io.object = async () => writeArchive(skill);
  return made;
}
const blocklistOf = (key = next) =>
  signBlocklist(
    {
      format: "ace-market-blocklist",
      issued: 5,
      hashes: [{ hash: skillHash, reason: "Mines coins" }],
      files: [],
      patterns: [],
      key: key.id,
    },
    key,
  );
const officialOf = (publisher = { id: "pub_someone", name: "ace" }) =>
  signOfficialList(
    { format: "ace-market-official", issued: 5, publisher, accounts: ["acct_x"], key: next.id },
    next,
  );

describe("the signer's re-scan", () => {
  it("blocks a version the newest blocklist names, with the reason", async () => {
    const { io, puts } = market({ "/v1/signer/pending": pendingOf({ blocklist: blocklistOf() }) });
    const report = await signPending(io, next, () => 30, trusted);
    expect(report.signed).toEqual([]);
    expect(report.blocked).toEqual([
      { version: "spade-skill/rescanned@1.0.0", reason: expect.stringContaining("Mines coins") },
    ]);
    expect(puts.map((put) => put.path)).toEqual(["/v1/signer/blocks/spade-skill/rescanned/1.0.0"]);
  });

  it("blocks even what a maintainer approved", async () => {
    const { io } = market({
      "/v1/signer/pending": pendingOf({ blocklist: blocklistOf() }, { approved: true }),
    });
    expect((await signPending(io, next, () => 30, trusted)).blocked).toHaveLength(1);
  });

  it("refuses a blocklist no trusted key signed", async () => {
    const { io } = market({
      "/v1/signer/pending": pendingOf({ blocklist: blocklistOf(testKey("stranger", 5)) }),
    });
    await expect(signPending(io, next, () => 30, trusted)).rejects.toThrow();
  });

  it("holds an official version until it is approved, then signs it", async () => {
    const held = market({ "/v1/signer/pending": pendingOf({ official: officialOf() }) });
    expect((await signPending(held.io, next, () => 30, trusted)).held).toHaveLength(1);
    expect(held.puts.map((put) => put.path)).toEqual([
      "/v1/signer/holds/spade-skill/rescanned/1.0.0",
    ]);
    const approved = market({
      "/v1/signer/pending": pendingOf({ official: officialOf() }, { approved: true }),
    });
    expect((await signPending(approved.io, next, () => 30, trusted)).signed).toEqual([
      "spade-skill/rescanned@1.0.0",
    ]);
  });

  it("signs a clean version of an ordinary publisher", async () => {
    const { io } = market({ "/v1/signer/pending": pendingOf() });
    expect((await signPending(io, next, () => 30, trusted)).signed).toEqual([
      "spade-skill/rescanned@1.0.0",
    ]);
  });
});

describe("the signed lists", () => {
  it("adds to the blocklist once, keeping what the previous key signed", async () => {
    const { io, puts } = memory({
      "/v1/signer/pending": { versions: [], withdrawals: [], blocklist: blocklistOf(old) },
    });
    for (const _ of [1, 2])
      await signBlocklistChange(io, next, () => 30, trusted, {
        kind: "pattern",
        text: "stratum+tcp://",
        reason: "Mining pool",
      });
    const list = verifyBlocklist(bodyOf<{ blocklist: unknown }>(puts).blocklist, keySetOf(next));
    expect(list.hashes.map((item) => item.reason)).toEqual(["Mines coins"]);
    expect(list.patterns.map((item) => item.text)).toEqual(["stratum+tcp://"]);
  });

  it("takes a publisher off the verified list with the reason they see", async () => {
    const earlier = signVerifiedList(
      {
        format: "ace-market-verified",
        issued: 5,
        publishers: [{ id: "pub_a", handle: "alpha", proofs: [{ kind: "account" }], at: 1 }],
        key: old.id,
      },
      old,
    );
    const { io, puts } = memory({
      "/v1/signer/pending": { versions: [], withdrawals: [], verified: earlier },
    });
    await signVerifiedChange(io, next, () => 30, trusted, {
      handle: "alpha",
      verified: false,
      reason: "Domain lapsed",
    });
    const upload = bodyOf<{ verified: unknown; revoked: unknown }>(puts);
    expect(verifyVerifiedList(upload.verified, keySetOf(next)).publishers).toEqual([]);
    expect(upload.revoked).toEqual([{ handle: "alpha", reason: "Domain lapsed" }]);
  });

  it("makes the official list with a new ace id when the market has none", async () => {
    const { io, puts } = memory({ "/v1/signer/pending": { versions: [], withdrawals: [] } });
    await signOfficialChange(
      io,
      next,
      () => 30,
      trusted,
      { account: "acct_owner", add: true },
      () => "pub_new_ace",
    );
    const list = verifyOfficialList(bodyOf<{ official: unknown }>(puts).official, keySetOf(next));
    expect(list.publisher).toEqual({ id: "pub_new_ace", name: "ace" });
    expect(list.accounts).toEqual(["acct_owner"]);
  });

  it("withdraws every live version of a publisher, each by version", async () => {
    const { io, puts } = memory({
      "/v1/signer/pending": { versions: [], withdrawals: [] },
      "/v1/signer/publishers/spammer": {
        publisher: { id: "pub_s", name: "spammer" },
        state: "suspended",
        live: [
          { type: "spade-skill", name: "one", version: "1.0.0", hash: "c".repeat(64) },
          { type: "suit", name: "two", version: "2.0.0", hash: "d".repeat(64) },
        ],
      },
    });
    const answer = await signWithdrawAll(io, next, () => 30, trusted, {
      handle: "spammer",
      reason: "Spam",
    });
    expect(answer.added).toBe(2);
    const list = verifyWithdrawn(bodyOf<{ withdrawn: unknown }>(puts).withdrawn, keySetOf(next));
    expect(list.withdrawn.map((item) => [item.scope, item.reason])).toEqual([
      ["version", "Spam"],
      ["version", "Spam"],
    ]);
  });
});
