import { afterEach, expect, test } from "vitest";
import { InstallAgent, ProviderKind } from "@ace/protocol";
import { checkCli, cliRequirements, providerCli } from "@ace/provider-kit/cli-requirements";
import { acpAgentCli, bindLocal, LocalInventory, profiles } from "./index.ts";
import { executable, temporary } from "./testing/support.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function installed(acpAgentId: string, version: string) {
  const f = await temporary();
  closers.push(f.close);
  const command = await executable(f.root, "agent", "#!/bin/sh\nexit 0\n");
  const identity = { acpAgentId, installationId: `${version}-1`, instanceId: `${version}-i` };
  const inventory = new LocalInventory([
    await bindLocal({ ...identity, version, command, args: [] }, { PATH: f.root }),
  ]);
  return { identity, inventory, env: { PATH: f.root } };
}

test("a reviewed ACP agent older than ace's minimum is refused before launch, naming both versions", async () => {
  const { identity, inventory, env } = await installed("official:gemini", "0.42.9");
  await expect(inventory.resolve(identity, env)).rejects.toMatchObject({
    code: "cli_too_old",
    installed: "0.42.9",
    required: "0.43.0",
    message:
      "Gemini CLI 0.42.9 is older than 0.43.0, the oldest version ace supports. Update Gemini CLI, then refresh.",
  });
});

test("a reviewed ACP agent at or above its minimum launches", async () => {
  for (const version of ["0.43.0", "0.62.0"]) {
    const { identity, inventory, env } = await installed("official:gemini", version);
    expect(await inventory.resolve(identity, env)).toMatchObject({ version });
  }
});

test("an ACP agent without a reviewed profile is admitted whatever its version", async () => {
  const { identity, inventory, env } = await installed("official:newcomer", "0.0.1");
  expect(await inventory.resolve(identity, env)).toMatchObject({ version: "0.0.1" });
});

test("every provider and ACP agent ace can launch is held to a declared minimum", () => {
  // Native providers: each kind ace launches names the CLI whose minimum it is held to.
  for (const provider of ProviderKind.options)
    if (provider !== "acp") expect(providerCli(provider), provider).toBeDefined();
  // ACP agents ace installs or has reviewed each have their own floor.
  const agents = new Set([
    ...InstallAgent.options.map((agent) => `official:${agent}`),
    ...profiles.map((profile) => `official:${profile.agent}`),
    "official:antigravity-acp",
  ]);
  for (const agent of agents) expect(acpAgentCli(agent), agent).toBeDefined();
  // Any other ACP agent is admitted by protocol version, the generic floor.
  expect(acpAgentCli("official:newcomer")).toBeUndefined();
  expect(cliRequirements.acp.minimum).toBe("1.0.0");
});

test("no reviewed ACP profile is below its agent's minimum, and the oldest profile is the floor", () => {
  const byAgent = new Map<string, string[]>();
  for (const profile of profiles)
    byAgent.set(profile.agent, [...(byAgent.get(profile.agent) ?? []), profile.version]);
  for (const [agent, versions] of byAgent) {
    const cli = acpAgentCli(`official:${agent}`);
    if (!cli) throw new Error(`${agent} has no declared minimum`);
    for (const version of versions) expect(checkCli(cli, version).status, agent).toBe("ok");
    expect(versions, agent).toContain(cliRequirements[cli].minimum);
  }
});
