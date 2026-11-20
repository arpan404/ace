import { expect, test } from "vitest";
import { profileFor } from "./profiles.ts";

test("an agent on its profile's verified version runs under it as verified", () => {
  expect(profileFor("gemini", "0.43.0")).toMatchObject({
    profile: { id: "gemini-043" },
    fit: "verified",
  });
});

test("a newer release of the same major version keeps the profile as compatible", () => {
  for (const version of ["0.43.1", "0.60.0", "0.99.9-preview.2"])
    expect(profileFor("gemini", version), version).toMatchObject({
      profile: { id: "gemini-043" },
      fit: "compatible",
    });
  expect(profileFor("codex-acp", "2.9.0")).toMatchObject({
    profile: { id: "codex-bridge" },
    fit: "compatible",
  });
});

test("a version outside the profile's range never gets the profile", () => {
  for (const [agent, version] of [
    ["gemini", "0.42.9"],
    ["gemini", "0.43.0-rc.1"],
    ["gemini", "1.0.0"],
    ["codex-acp", "3.0.0"],
    ["codex-acp", "2.1.0"],
    ["auggie", "latest"],
    ["unprofiled-agent", "0.43.0"],
  ] as const)
    expect(profileFor(agent, version), `${agent} ${version}`).toBeUndefined();
});

test("an agent with several profiles runs under the one verified closest below its version", () => {
  expect(profileFor("qwen-code", "0.0.20")).toMatchObject({
    profile: { id: "qwen-old" },
    fit: "compatible",
  });
  expect(profileFor("qwen-code", "0.30.0")).toMatchObject({
    profile: { id: "qwen-modern" },
    fit: "compatible",
  });
  expect(profileFor("qwen-code", "0.0.14")?.profile.id).toBe("qwen-old");
});
