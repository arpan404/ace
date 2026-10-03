import { expect, test } from "vitest";
import { codexCapabilities } from "./index.ts";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
const cli: DiscoveryResult = {
  installed: true,
  auth: "logged_in",
  version: "0.159.1",
  loginHint: "codex login",
};
test("verified Codex versions expose controls for streaming children and background terminals", () => {
  expect(codexCapabilities(cli)).toMatchObject({
    steer: true,
    resume: true,
    fork: true,
    subagentTranscripts: true,
    backgroundTaskControl: true,
    backgroundVisibility: "full",
    planMode: true,
    interruptCascades: false,
    rewindFiles: false,
  });
  expect(codexCapabilities({ ...cli, version: "0.160.0" }).steer).toBe(true);
});
test("uninstalled, old and unknown versions do not advertise experimental controls", () => {
  for (const discovered of [
    { ...cli, installed: false },
    { ...cli, version: "0.158.0" },
    { ...cli, version: "unrecognized" },
  ])
    expect(codexCapabilities(discovered)).toMatchObject({
      steer: false,
      subagentTranscripts: false,
      backgroundTaskControl: false,
      backgroundVisibility: "none",
    });
});
