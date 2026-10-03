import { expect, it } from "vitest";
import { Capabilities } from "@ace/protocol";
import { rootProviderControls, childProviderControls } from "./index.ts";
const sdk = Capabilities.parse({
  steer: true,
  interruptCascades: true,
  resume: true,
  fork: true,
  subagentTranscripts: false,
  backgroundTaskControl: false,
  backgroundVisibility: "partial",
  planMode: false,
  tokenUsage: true,
  imageInput: true,
  rewindFiles: false,
  approvals: "sandbox-only",
  steeringMode: "interrupt-restart",
  forkMode: "context-handoff",
  childControls: "read-only",
  childFidelity: "summary",
});
it("shows interrupt/restart and context handoff without offering approval or child control", () => {
  expect(rootProviderControls(sdk)).toMatchObject({
    steeringMode: "interrupt-restart",
    forkMode: "context-handoff",
    interactiveApproval: false,
    sandboxOnly: true,
    planReview: false,
  });
  expect(childProviderControls(sdk)).toEqual({
    send: false,
    interrupt: false,
    resume: false,
    fork: false,
    stopTask: false,
    fidelity: "summary",
  });
});
it("preserves prior provider controls when additive SDK policy fields are absent", () => {
  const { approvals: _a, steeringMode: _s, forkMode: _f, childControls: _c, ...legacy } = sdk;
  expect(rootProviderControls(legacy)).toMatchObject({
    steeringMode: "native",
    forkMode: "native",
    interactiveApproval: true,
  });
  expect(childProviderControls(legacy).resume).toBe(true);
});
