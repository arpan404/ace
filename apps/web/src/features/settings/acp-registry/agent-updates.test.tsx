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
const installed = {
  ...identity,
  version: "1.0.0",
  profileRevision: "generic-v1",
  source: "user-local",
  evidence: "user_local_binding",
} as const;
/** The update the daemon lists: files on disk now, what was approved before them, the generation. */
const pending = (executableDigest: string) => ({
  ...identity,
  changed: ["agent" as const],
  executableDigest,
  previousExecutableDigest: "a".repeat(64),
  generation: 0,
  observedAt: 1,
});

test("an agent that updated itself waits under Providers until the person approves it", async () => {
  const app = harness();
  const registry = app.daemon.services.registry;
  registry.installations.push(installed);
  registry.updates = [pending("b".repeat(64))];
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

test("Approve sends the update the person saw, so one that changed since isn't approved unseen", async () => {
  const app = harness();
  const registry = app.daemon.services.registry;
  registry.installations.push(installed);
  registry.updates = [pending("b".repeat(64))];
  await app.open("/settings/providers");
  const group = await screen.findByRole(
    "region",
    { name: "Waiting for your approval" },
    { timeout: 10_000 },
  );
  // The agent changes again behind the shown row.
  registry.updates = [pending("c".repeat(64))];
  await userEvent.click(within(group).getByRole("button", { name: /Approve .*update/ }));
  expect(
    await screen.findAllByText(
      "It changed again since you looked. Check it and approve again.",
      undefined,
      {
        timeout: 10_000,
      },
    ),
  ).not.toHaveLength(0);
  expect(
    registry.installations.find((entry) => entry.installationId === identity.installationId)
      ?.approvals,
  ).toBeUndefined();
}, 30_000);

test("nothing waits, nothing shows", async () => {
  const app = harness();
  await app.open("/settings/providers");
  await screen.findByRole("region", { name: "Installed" }, { timeout: 10_000 });
  expect(screen.queryByRole("region", { name: "Waiting for your approval" })).toBeNull();
}, 30_000);
