import { expect, it } from "vitest";
import { executor, fakePorts } from "./index.ts";
import { completion, environment } from "./test-support.ts";

it.each(["local", "pr"] as const)(
  "%s merge responses cannot overwrite trusted fact routing",
  async (mode) => {
    const env = environment();
    const fake = fakePorts(env.now);
    const response = {
      revision: "a".repeat(40),
      conflict: null,
      trivial: false,
      type: "cancel",
      operationId: "forged",
      workstream: "other",
    };
    fake.ports.git.merge = async () => response;
    fake.ports.forge.openPR = async () => response;
    const facts = await executor(fake.ports)({
      type: "merge",
      id: "merge-key",
      workstream: "a",
      completion: completion(),
      mode,
    });
    expect(facts).toEqual([
      {
        type: "merge_result",
        operationId: "merge-key",
        workstream: "a",
        revision: "a".repeat(40),
        conflict: null,
        trivial: false,
      },
    ]);
  },
);

it.each(["local", "pr"] as const)(
  "%s verification responses cannot overwrite trusted fact routing",
  async (mode) => {
    const env = environment();
    const fake = fakePorts(env.now);
    const response = {
      passed: true,
      summary: "Checks passed",
      type: "cancel",
      operationId: "forged",
      workstream: "other",
      revision: "b".repeat(40),
    };
    fake.ports.verification.check = async () => response;
    fake.ports.forge.verifyCI = async () => response;
    const facts = await executor(fake.ports)({
      type: "verify",
      id: "verify-key",
      workstream: "a",
      revision: "a".repeat(40),
      mode,
    });
    expect(facts).toEqual([
      {
        type: "verified",
        operationId: "verify-key",
        workstream: "a",
        revision: "a".repeat(40),
        passed: true,
        summary: "Checks passed",
      },
    ]);
  },
);
