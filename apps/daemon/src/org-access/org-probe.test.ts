import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { orgProbe } from "./org-probe.ts";

// ADR 0209 §4.2: work in flight ends at enrollment itself, not at the next sweep, so the probe
// tells its listeners the moment the machine's account says its owner changed.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("tells its listeners when the machine becomes an organization's host", () => {
  const home = mkdtempSync(join(tmpdir(), "ace-probe-"));
  homes.push(home);
  const probe = orgProbe(home);
  let org: string | undefined;
  const changes = new Set<() => void>();
  probe.bind({
    ownerKnown: () => true,
    accessOrg: () => org,
    onChange: (listener) => {
      changes.add(listener);
      return () => changes.delete(listener);
    },
  });
  const heard: (string | undefined)[] = [];
  probe.onChange?.(() => heard.push(probe.org()));
  org = "org_acme";
  for (const listener of changes) listener();
  expect(heard).toEqual(["org_acme"]);
});

it("takes a seal it can't read or parse for an organization's, before the account loads", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  for (const seal of ["{not json", "directory"]) {
    const home = mkdtempSync(join(tmpdir(), "ace-probe-"));
    homes.push(home);
    if (seal === "directory") mkdirSync(join(home, "ace-org-seal.json"));
    else writeFileSync(join(home, "ace-org-seal.json"), seal);
    expect(orgProbe(home).org()).toBeDefined();
  }
});

it("reads a person's machine, with no seal at all, as nobody's organization", () => {
  const home = mkdtempSync(join(tmpdir(), "ace-probe-"));
  homes.push(home);
  expect(orgProbe(home).org()).toBeUndefined();
});
