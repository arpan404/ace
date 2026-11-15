// A process test: the plugin is installed from a real local Git repository, as every manager test
// does; what Spade receives is checked through the service boundary the daemon mounts.
import { expect, test } from "vitest";
import { PluginService } from "./index.ts";
import { fixture, sampleFiles, sampleManifest } from "./test-support.ts";

test("Spade receives an accepted plugin's components with their text and its executions as accepted", async () => {
  const f = await fixture();
  try {
    const review = await f.prepare();
    await f.manager.accept(review);
    const service = new PluginService(f.manager);
    const answer = await service.handle({ type: "plugins.spade", name: "sample" });
    if (answer.type !== "plugins.spade") throw new Error(`unexpected ${answer.type}`);
    const { plugin } = answer;
    expect(plugin.install).toMatchObject({ name: "sample", hash: review.hash });
    expect(plugin.enabled).toBe(true);
    expect(plugin.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "rule", name: "style", text: "Use TypeScript." }),
        expect.objectContaining({
          kind: "skill",
          name: "review",
          text: sampleFiles["skills/review/SKILL.md"],
        }),
        expect.objectContaining({ kind: "command", name: "check" }),
        expect.objectContaining({ kind: "agent", name: "reviewer" }),
      ]),
    );
    // Exactly what the person accepted: the same hook strings and server commands.
    expect(plugin.executions).toEqual(review.executions);
    expect(plugin.executions).toContainEqual(
      expect.objectContaining({ kind: "stdio", name: "tools", env: { MODE: "local" } }),
    );
    expect(plugin.root.endsWith(review.hash)).toBe(true);
  } finally {
    await f.close();
  }
});

test("a plugin turned off in ace answers as off, and one not installed is refused", async () => {
  const f = await fixture();
  try {
    await f.manager.accept(await f.prepare());
    const service = new PluginService(f.manager);
    await service.handle({
      type: "plugins.availability",
      name: "sample",
      enabled: false,
      providers: [],
    });
    expect(await service.handle({ type: "plugins.spade", name: "sample" })).toMatchObject({
      plugin: { enabled: false },
    });
    await expect(service.handle({ type: "plugins.spade", name: "other" })).rejects.toThrow(
      "Plugin not installed",
    );
  } finally {
    await f.close();
  }
});

test("a component too large for the answer is listed without its text", async () => {
  const big = "x".repeat(300_000);
  const f = await fixture({
    ...sampleFiles,
    "ace-plugin.json": JSON.stringify({
      ...sampleManifest,
      rules: [...sampleManifest.rules, { name: "huge", path: "rules/huge.md" }],
    }),
    "rules/huge.md": big,
  });
  try {
    await f.manager.accept(await f.prepare());
    const answer = await new PluginService(f.manager).handle({
      type: "plugins.spade",
      name: "sample",
    });
    if (answer.type !== "plugins.spade") throw new Error(`unexpected ${answer.type}`);
    const huge = answer.plugin.components.find((entry) => entry.name === "huge");
    expect(huge?.text).toBeUndefined();
    expect(huge?.omitted).toBeTruthy();
    expect(answer.plugin.components.find((entry) => entry.name === "style")?.text).toBe(
      "Use TypeScript.",
    );
  } finally {
    await f.close();
  }
});
