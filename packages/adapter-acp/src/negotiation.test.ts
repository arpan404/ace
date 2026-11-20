import { matchProfile } from "@ace/agent-registry";
import { expect, test } from "vitest";
import { negotiate, genericQuirks } from "./index.ts";
test("an agent reporting another version than approved runs without its profile, and says which", () => {
  const response = {
    protocolVersion: 1,
    agentInfo: { name: "synthetic", version: "2.0.0" },
    agentCapabilities: { loadSession: true },
  };
  const profile = matchProfile("gemini", "0.43.0");
  const negotiated = negotiate(response, genericQuirks, "0.43.0", profile);
  expect(negotiated.profile).toBeUndefined();
  expect(negotiated.versionChanged).toEqual({ approved: "0.43.0", reported: "2.0.0" });
  expect(
    negotiate(
      { ...response, agentInfo: { name: "synthetic", version: "0.43.0" } },
      genericQuirks,
      "0.43.0",
      profile,
    ).profile,
  ).toBe(profile);
});
