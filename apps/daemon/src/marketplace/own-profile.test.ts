import type { MarketProfile, MarketResult } from "@ace/protocol/marketplace";
import { expect, test } from "vitest";
import { markOwnProfile } from "./own-profile.ts";
import { badgesOf } from "./trust.ts";

const profile = (id: string, extra: Partial<MarketProfile> = {}): MarketProfile => ({
  id,
  handle: "ace",
  displayName: "ace",
  bio: "",
  links: [],
  joined: 1,
  verified: true,
  proofs: [],
  pins: [],
  ...extra,
});

const official = badgesOf({
  official: {
    format: "ace-market-official",
    issued: 1,
    publisher: { id: "pub_ace", name: "ace" },
    accounts: [],
    key: "k1",
  },
});

const profileAnswer = (value: MarketProfile): MarketResult => ({
  op: "publish",
  answer: { kind: "profile", profile: value },
});

test("the signed-in account is marked official only when the signed list names its publisher id", () => {
  const mine = markOwnProfile(profileAnswer(profile("pub_ace")), official);
  const other = markOwnProfile(profileAnswer(profile("pub_x")), official);

  expect(
    mine.op === "publish" && mine.answer.kind === "profile" && mine.answer.profile.official,
  ).toBe(true);
  expect(
    other.op === "publish" && other.answer.kind === "profile" && other.answer.profile.official,
  ).toBeUndefined();
});

test("an official flag the market put on a profile is dropped when no signed list backs it", () => {
  const claimed = markOwnProfile(profileAnswer(profile("pub_x", { official: true })), official);
  const unlisted = markOwnProfile(
    profileAnswer(profile("pub_ace", { official: true })),
    badgesOf({}),
  );

  for (const result of [claimed, unlisted])
    expect(
      result.op === "publish" && result.answer.kind === "profile" && result.answer.profile.official,
    ).toBeUndefined();
});

test("a top publisher is official by the handle the signed list names, and nobody else", () => {
  expect(official.officialHandle("ace")).toBe(true);
  expect(official.officialHandle("ace-lookalike")).toBe(false);
  expect(badgesOf({}).officialHandle("ace")).toBe(false);
});
