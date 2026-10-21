import { expect, it } from "vitest";
import { developerIdIdentities, notaryCredentials } from "./release-signing.ts";

it("notarization uses the first complete credential group, as electron-builder does", () => {
  expect(notaryCredentials({})).toEqual({ kind: "none" });
  expect(notaryCredentials({ APPLE_KEYCHAIN_PROFILE: "ace" })).toEqual({
    kind: "keychain-profile",
  });
  expect(
    notaryCredentials({ APPLE_API_KEY: "/k.p8", APPLE_API_KEY_ID: "ID", APPLE_API_ISSUER: "I" }),
  ).toEqual({ kind: "api-key" });
  expect(
    notaryCredentials({
      APPLE_ID: "me@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "pw",
      APPLE_TEAM_ID: "T",
      APPLE_KEYCHAIN_PROFILE: "ace",
    }),
  ).toEqual({ kind: "apple-id" });
});

it("a half-set credential group names what is missing instead of skipping notarization", () => {
  expect(notaryCredentials({ APPLE_ID: "me@example.com", APPLE_KEYCHAIN_PROFILE: "ace" })).toEqual({
    kind: "incomplete",
    missing: ["APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
  });
  expect(notaryCredentials({ APPLE_API_KEY_ID: "ID" })).toEqual({
    kind: "incomplete",
    missing: ["APPLE_API_KEY", "APPLE_API_ISSUER"],
  });
});

it("only Developer ID Application certificates can sign a release", () => {
  const keychain = [
    '  1) 2F0D887215B823FE052EBF5EFE40169ED51DEC71 "Apple Development: Ada Lovelace (BVT55BT25R)"',
    '  2) 250B346D0E4705ECADB62A179772E1FE35720790 "Apple Distribution: Ada Lovelace (5J88TLUP2J)"',
    '  3) 9A0B346D0E4705ECADB62A179772E1FE35720790 "Developer ID Application: Ada Lovelace (5J88TLUP2J)"',
    "     3 valid identities found",
  ].join("\n");
  expect(developerIdIdentities(keychain)).toEqual([
    "Developer ID Application: Ada Lovelace (5J88TLUP2J)",
  ]);
  expect(developerIdIdentities(keychain.split("\n").slice(0, 2).join("\n"))).toEqual([]);
});
