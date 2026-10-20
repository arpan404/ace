import { expect, test } from "vitest";
import { configuredRoles, roleSettingKeys } from "./roles.ts";
import { fixture } from "./test-support.ts";

async function roles(f: Awaited<ReturnType<typeof fixture>>) {
  const read = await f.service.read({ keys: roleSettingKeys, scope: {} });
  return configuredRoles(Object.fromEntries(read.entries.map((entry) => [entry.key, entry.value])));
}

test("no role is set until the person picks its provider", async () => {
  const f = await fixture();
  try {
    expect(await roles(f)).toEqual({});
    // A model or effort on its own still leaves the role to nobody.
    await f.service.set("providers.reviewer.model", "opus-5.5", { kind: "global" });
    await f.service.set("providers.reviewer.reasoningEffort", "xhigh", { kind: "global" });
    expect(await roles(f)).toEqual({});
  } finally {
    await f.close();
  }
});

test("a set role carries its provider and only the fields changed from default", async () => {
  const f = await fixture();
  try {
    await f.service.set("providers.coder.provider", "codex", { kind: "global" });
    await f.service.set("providers.verifier.provider", "claude", { kind: "global" });
    await f.service.set("providers.verifier.model", "opus-5.5", { kind: "global" });
    await f.service.set("providers.verifier.reasoningEffort", "high", { kind: "global" });
    await f.service.set("providers.verifier.tier", "priority", { kind: "global" });
    expect(await roles(f)).toEqual({
      build: { provider: "codex" },
      verify: { provider: "claude", model: "opus-5.5", effort: "high", tier: "priority" },
    });
    await f.service.set("providers.coder.provider", null, { kind: "global" });
    expect(Object.keys(await roles(f))).toEqual(["verify"]);
  } finally {
    await f.close();
  }
});

test("roles are refused on a project or thread layer", async () => {
  const f = await fixture();
  try {
    await expect(
      f.service.set("providers.planner.provider", "claude", {
        kind: "workspace",
        workspace: f.workspace,
      }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      f.service.set("providers.planner.model", "x", { kind: "thread", thread: "t1" }),
    ).rejects.toMatchObject({ code: "validation" });
  } finally {
    await f.close();
  }
});
