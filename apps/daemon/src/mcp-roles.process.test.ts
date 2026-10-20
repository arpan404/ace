import { afterEach, expect, it } from "vitest";
import { claudeInjection, codexInjection } from "@ace/mcp-server";
import { evalWorld, type EvalWorld } from "./evals/world.ts";

let world: EvalWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

it("a session carries the person's roles in its instructions from start to end, and only when set", async () => {
  world = await evalWorld({ browser: false });
  const settings = world.daemon.settings;
  const global = { kind: "global" } as const;
  const { agent: before } = await world.agent({});
  expect(before.instructions).not.toContain("Roles:");

  await settings.set("providers.verifier.provider", "claude", global);
  await settings.set("providers.verifier.model", "opus-5.5", global);
  await settings.set("providers.verifier.reasoningEffort", "xhigh", global);
  const { agent, connection } = await world.agent({});
  const line = "Roles: verify claude opus-5.5 xhigh. Delegate with runRole.";
  expect(agent.instructions).toContain(line);
  expect(codexInjection(connection).developerInstructions).toContain(line);

  // A change mid-session leaves this session's instructions as they were; the next one has it.
  await settings.set("providers.coder.provider", "codex", global);
  expect(claudeInjection(connection).developerInstructions).toContain(line);
  expect(claudeInjection(connection).developerInstructions).not.toContain("build codex");
  const { agent: later } = await world.agent({});
  expect(later.instructions).toContain(
    "Roles: build codex · verify claude opus-5.5 xhigh. Delegate with runRole.",
  );
});
