import { matchProfile } from "@ace/agent-registry";
import { expect, test } from "vitest";
import { negotiate, genericQuirks } from "./index.ts";
test("an agent reporting a version outside its profile's range runs without the profile, and says which", () => {
  const response = {
    protocolVersion: 1,
    agentInfo: { name: "synthetic", version: "2.0.0" },
    agentCapabilities: { loadSession: true },
  };
  const profile = matchProfile("gemini", "0.43.0");
  const negotiated = negotiate(response, genericQuirks, "0.43.0", profile);
  expect(negotiated.profile).toBeUndefined();
  expect(negotiated.profileFit).toBeUndefined();
  expect(negotiated.versionChanged).toEqual({
    approved: "0.43.0",
    reported: "2.0.0",
    runsAs: "generic",
  });
  const same = negotiate(
    { ...response, agentInfo: { name: "synthetic", version: "0.43.0" } },
    genericQuirks,
    "0.43.0",
    profile,
  );
  expect(same.profile).toBe(profile);
  expect(same.profileFit).toBe("verified");
});

test("an agent that updated within its profile's major version keeps the profile as compatible", () => {
  const profile = matchProfile("gemini", "0.43.0");
  const negotiated = negotiate(
    {
      protocolVersion: 1,
      agentInfo: { name: "synthetic", version: "0.45.2" },
      agentCapabilities: { loadSession: true },
    },
    genericQuirks,
    "0.43.0",
    profile,
  );
  expect(negotiated.profile).toBe(profile);
  expect(negotiated.profileFit).toBe("compatible");
  expect(negotiated.versionChanged).toEqual({
    approved: "0.43.0",
    reported: "0.45.2",
    runsAs: "profile",
  });
});

test("an agent that went back below its profile's verified version never gets the profile", () => {
  const profile = matchProfile("claude-acp", "0.85.1");
  for (const reported of ["0.85.0", "0.85.1-beta.1", "1.0.0", "not a version"]) {
    const negotiated = negotiate(
      { protocolVersion: 1, agentInfo: { name: "synthetic", version: reported } },
      genericQuirks,
      "0.85.1",
      profile,
    );
    expect(negotiated.profile, reported).toBeUndefined();
  }
});
