import { expect, test } from "vitest";
import { assertScreenHelperIdentity, parseScreenHelperIdentity } from "./screen-identity.ts";

test("packaging preserves local identities without requiring a production certificate", () => {
  const identity = {
    requirement: 'designated => cdhash H"1234"',
    teamId: "not set",
    bundleId: "dev.ace.screen-helper",
  };
  expect(() => assertScreenHelperIdentity(identity, { ...identity })).not.toThrow();
  for (const field of ["requirement", "teamId", "bundleId"] as const)
    expect(() => assertScreenHelperIdentity(identity, { ...identity, [field]: "changed" })).toThrow(
      `${field} changed`,
    );
});

test("codesign's implicit ad-hoc requirement is captured with its unsigned team", () => {
  expect(
    parseScreenHelperIdentity(
      'Signature=adhoc\nTeamIdentifier=not set\n# designated => cdhash H"1234"\n',
      "dev.ace.screen-helper",
    ),
  ).toEqual({
    requirement: 'designated => cdhash H"1234"',
    teamId: "not set",
    bundleId: "dev.ace.screen-helper",
  });
  expect(() =>
    parseScreenHelperIdentity("TeamIdentifier=not set\n", "dev.ace.screen-helper"),
  ).toThrow();
});
