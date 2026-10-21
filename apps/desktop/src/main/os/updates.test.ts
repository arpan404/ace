import { expect, it } from "vitest";
import { developerIdSigned } from "./updates.ts";

it("only a team-signed app updates itself on macOS; ad-hoc and unsigned builds open the release", () => {
  const signed = [
    "Executable=/Applications/ace.app/Contents/MacOS/ace",
    "Authority=Developer ID Application: Ada Lovelace (5J88TLUP2J)",
    "TeamIdentifier=5J88TLUP2J",
  ].join("\n");
  const adhoc = [
    "Executable=/Applications/ace.app/Contents/MacOS/ace",
    "Signature=adhoc",
    "TeamIdentifier=not set",
  ].join("\n");
  expect(developerIdSigned(signed)).toBe(true);
  expect(developerIdSigned(adhoc)).toBe(false);
  expect(developerIdSigned("/Applications/ace.app: code object is not signed at all")).toBe(false);
});
