import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const identity = {
  acpAgentId: "local:kiro",
  installationId: "kiro-1",
  instanceId: "kiro-1:default",
};

test("an agent that updated itself waits under Providers until the person approves it", async () => {
  const app = harness();
  const registry = app.daemon.services.registry;
  registry.installations.push({
    ...identity,
    version: "1.0.0",
    profileRevision: "generic-v1",
    source: "user-local",
    evidence: "user_local_binding",
  });
  registry.updates = [
    { ...identity, changed: ["agent"], executableDigest: "b".repeat(64), observedAt: 1 },
  ];
  await app.open("/settings/providers");
  const group = await screen.findByRole(
    "region",
    { name: "Waiting for your approval" },
    { timeout: 10_000 },
  );
  expect(group.textContent).toContain("It was updated. ace won't run it until you approve.");
  await userEvent.click(within(group).getByRole("button", { name: /Approve .*update/ }));
  await waitFor(
    () => expect(screen.queryByRole("region", { name: "Waiting for your approval" })).toBeNull(),
    { timeout: 10_000 },
  );
  // The approval is for the same installation, recorded with the digest the person saw.
  const approved = registry.installations.find(
    (entry) => entry.installationId === identity.installationId,
  );
  expect(approved?.approvals?.at(-1)?.executableDigest).toBe("b".repeat(64));
  expect(registry.updates).toEqual([]);
}, 30_000);

test("nothing waits, nothing shows", async () => {
  const app = harness();
  await app.open("/settings/providers");
  await screen.findByRole("region", { name: "Installed" }, { timeout: 10_000 });
  expect(screen.queryByRole("region", { name: "Waiting for your approval" })).toBeNull();
}, 30_000);
