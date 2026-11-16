import { describe, expect, it } from "vitest";
import { signPending, signReview, type SignerIo } from "./signer.ts";
import { verifyReviewMark, verifyWithdrawn } from "./signing.ts";
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
