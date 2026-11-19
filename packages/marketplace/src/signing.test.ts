import { describe, expect, it } from "vitest";
import { hashFiles } from "./hash.ts";
import { manifestMismatch, verifyManifest, verifyReviewMark, verifyWithdrawn } from "./signing.ts";
import type { VersionManifest } from "@ace/protocol/marketplace";
import {
  folder,
  keySetOf,
  sampleSkill,
  signedVersion,
  signedWithdrawn,
  testKey,
} from "./testing.ts";

const key = testKey();
const keys = keySetOf(key);
const version = signedVersion({
  type: "spade-skill",
  name: "triage-mail",
  files: sampleSkill(),
  reviewed: true,
});

describe("signed manifests", () => {
  it("verify against the key that signed them", () => {
    const manifest = verifyManifest(version.manifest, keys);
    expect(manifest.hash).toBe(version.hash);
  });

  it("verify with either of two shipped keys, so a key can rotate", () => {
    const next = testKey("next", 9);
    const signed = signedVersion({
      type: "spade-skill",
      name: "triage-mail",
      files: sampleSkill(),
      key: next,
    });
    expect(verifyManifest(signed.manifest, keySetOf(key, next)).key).toBe("next");
  });

  it("are refused when signed by a key the build doesn't ship", () => {
    const stranger = signedVersion({
      type: "spade-skill",
      name: "x",
      files: sampleSkill("x"),
      key: testKey("test", 3),
    });
    expect(() => verifyManifest(stranger.manifest, keys)).toThrow(/signature/);
    const unknown = signedVersion({
      type: "spade-skill",
      name: "x",
      files: sampleSkill("x"),
      key: testKey("other", 3),
    });
    expect(() => verifyManifest(unknown.manifest, keys)).toThrow(/doesn't know/);
  });

  it("are refused when any field changed after signing", () => {
    const body = { ...(version.manifest.body as VersionManifest), version: "9.9.9" };
    expect(() => verifyManifest({ ...version.manifest, body }, keys)).toThrow(/signature/);
  });

  it("never verify as another kind of statement", () => {
    expect(() => verifyReviewMark(version.manifest, keys)).toThrow();
    expect(() => verifyManifest(version.review, keys)).toThrow();
    expect(verifyReviewMark(version.review, keys).reviewed).toBe(true);
  });
});

describe("an archive against its manifest", () => {
  const manifest = verifyManifest(version.manifest, keys);

  it("matches when it holds exactly the signed files", () => {
    expect(manifestMismatch(manifest, hashFiles(sampleSkill()))).toBeUndefined();
  });

  it.each([
    ["a changed file", folder({ "SKILL.md": "changed" })],
    ["an extra file", [...sampleSkill(), ...folder({ "extra.md": "x" })]],
    [
      "a file made executable",
      sampleSkill().map((file) => Object.assign(file, { executable: true })),
    ],
  ])("is refused for %s", (_label, files) => {
    expect(manifestMismatch(manifest, hashFiles(files))).toBeDefined();
  });
});

describe("the withdrawn list", () => {
  it("verifies and names each withdrawn hash with its reason", () => {
    const list = verifyWithdrawn(
      signedWithdrawn([{ hash: version.hash, reason: "Sends mail without asking" }]),
      keys,
    );
    expect(list.withdrawn).toEqual([
      expect.objectContaining({ hash: version.hash, reason: "Sends mail without asking" }),
    ]);
  });

  it("is refused when its entries were edited", () => {
    const signed = signedWithdrawn([{ hash: version.hash, reason: "Bad" }]);
    const body = { ...(signed.body as object), withdrawn: [] };
    expect(() => verifyWithdrawn({ ...signed, body }, keys)).toThrow(/signature/);
  });
});
