import { expect, it } from "vitest";
import { MaintenanceGate } from "@ace/service";
import { automationAdmission } from "./automation-executor.ts";

// ADR 0209 §4.2: a scheduled run is deferred work. On an organization's host nothing yet
// records whose tree a run would be, so every due run is skipped there, saying why.

const probe = (org: string | undefined) => ({ org: () => org, bind: () => {} });

it("an organization's host admits no automation run, and says why rather than 'paused'", () => {
  const { admission } = automationAdmission({
    maintenance: new MaintenanceGate(() => 0),
    orgHost: probe("org_acme"),
  });
  expect(admission?.open()).toBe(false);
  expect(admission?.closedReason?.()).toContain("organization's host");
});

it("a person's machine admits runs as its pause says, as before", () => {
  const gate = new MaintenanceGate(() => 0);
  const { admission } = automationAdmission({ maintenance: gate, orgHost: probe(undefined) });
  expect(admission?.open()).toBe(true);
  expect(admission?.closedReason?.()).toBeUndefined();
});
