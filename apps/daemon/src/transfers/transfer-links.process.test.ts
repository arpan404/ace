import { expect, it } from "vitest";
import { transferMachines } from "./transfer-test-support.ts";

it("a link says it takes transfers even while that machine keeps agents out", async () => {
  const m = await transferMachines();
  // The target's agent access is off by default: agents can't use it, the person's moves can.
  expect(await m.here.links()).toMatchObject([
    {
      profile: "studio",
      hostId: m.targetHostId,
      name: "Studio",
      status: "refused",
      projects: true,
    },
  ]);
  await m.target.daemon.settings.set("remote.agentAccess", "operate", { kind: "global" });
  expect(await m.here.links()).toMatchObject([
    { profile: "studio", status: "online", access: "operate", projects: true },
  ]);
});

it("a link whose device there lacks projects says it can't take transfers", async () => {
  const m = await transferMachines({ scopes: ["read", "operate"] });
  await m.target.daemon.settings.set("remote.agentAccess", "operate", { kind: "global" });
  expect(await m.here.links()).toMatchObject([{ status: "online", projects: false }]);
});
