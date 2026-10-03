import { expect, test } from "vitest";
import { AgentCatalog, AgentRegistry } from "@ace/agent-registry";
import { setup, cleanups } from "./remote-test-support.ts";
async function registry() {
  let installed = false;
  const catalog = await AgentCatalog.open({
    cache: { load: async () => undefined, save: async () => {} },
    target: "linux-x86_64",
    now: () => 1,
    fetch: async () =>
      new Response(
        JSON.stringify({
          version: "1.0.0",
          agents: [
            {
              id: "sample",
              version: "1.0.0",
              name: "Sample",
              description: "Synthetic",
              license_url: "https://example.org/license",
              distribution: {
                binary: { "linux-x86_64": { archive: "https://example.org/agent", cmd: "agent" } },
              },
            },
          ],
        }),
      ),
  });
  const agents = await AgentRegistry.open({
    catalog,
    storage: {
      load: async () => undefined,
      save: async () => {
        installed = true;
      },
    },
    root: "/unused-test-destination",
    target: "linux-x86_64",
    env: {},
    runtime: {
      fetch: async () => {
        throw new Error("Must not install");
      },
    },
  });
  cleanups.push(() => agents.close());
  await catalog.refresh();
  return { agents, installed: () => installed };
}
test("registry metadata uses read scope while install controls require admin and operate scopes", async () => {
  const { agents, installed } = await registry();
  const f = await setup({ agentRegistry: agents });
  const device = await f.pair(["read"]);
  const ticket = await f.ticket(device.token);
  const client = await f.connectTicket(device.device.id, ticket.ticket);
  await client.next();
  client.send({ type: "registry.list", requestId: "list", offset: 0, limit: 10 });
  expect(await client.next()).toMatchObject({
    type: "registry.result",
    requestId: "list",
    result: {
      ok: true,
      agents: [
        {
          acpAgentId: "official:sample",
          auth: "unknown",
          coverage: "generic",
          visibility: "limited",
        },
      ],
    },
  });
  client.send({
    type: "registry.install-plan",
    requestId: "preview",
    acpAgentId: "official:sample",
    runtime: "binary",
  });
  expect(await client.next()).toMatchObject({
    type: "registry.result",
    result: { ok: false, reason: "admin scope required" },
  });
  client.send({ type: "registry.refresh", requestId: "refresh" });
  expect(await client.next()).toMatchObject({
    result: { ok: false, reason: "operate scope required" },
  });
  expect(installed()).toBe(false);
});

test.each([
  ["read", "admin"],
  ["read", "operate"],
] as const)(
  "install plan and intent deny missing required scope %j before executing",
  async (...scopes) => {
    const { agents, installed } = await registry();
    const preview = await agents.handle({
      type: "registry.install-plan",
      requestId: "local-preview",
      acpAgentId: "official:sample",
      runtime: "binary",
    });
    if (!preview.result.ok || !("plan" in preview.result)) throw new Error("Missing plan");
    const f = await setup({ agentRegistry: agents });
    const device = await f.pair([...scopes]);
    const ticket = await f.ticket(device.token);
    const client = await f.connectTicket(device.device.id, ticket.ticket);
    await client.next();
    for (const request of [
      {
        type: "registry.install-plan",
        requestId: "plan",
        acpAgentId: "official:sample",
        runtime: "binary",
      },
      {
        type: "registry.install-intent",
        requestId: "intent",
        digest: preview.result.plan.digest,
        intentId: "approved",
      },
    ] as const) {
      client.send(request);
      expect(await client.next()).toMatchObject({
        type: "registry.result",
        requestId: request.requestId,
        result: {
          ok: false,
          reason: scopes.some((scope) => scope === "admin")
            ? "operate scope required"
            : "admin scope required",
        },
      });
    }
    expect(installed()).toBe(false);
    expect(agents.inventory.list()).toEqual([]);
  },
);
