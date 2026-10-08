import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { PluginService, preparePluginSession } from "./index.ts";
import { fixture, sampleFiles, sampleManifest } from "./test-support.ts";

const files = {
  ...sampleFiles,
  "ace-plugin.json": JSON.stringify({
    ...sampleManifest,
    skills: [...sampleManifest.skills, { name: "write", path: "skills/write" }],
  }),
  "skills/write/SKILL.md": "---\nname: write\ndescription: Write code\n---\nWrite the change.\n",
};

async function projected(
  f: Awaited<ReturnType<typeof fixture>>,
  provider: "codex" | "claude" | "cursor" | "opencode",
) {
  const root = join(f.root, `session-${provider}`);
  const session = await preparePluginSession(f.manager, provider, root);
  return {
    session,
    read: (name: string) =>
      readFile(join(root, "generated/plugins/sample/skills", name, "SKILL.md"), "utf8"),
  };
}

test("turning off one skill survives restart and omits it from each provider while keeping its sibling", async () => {
  const f = await fixture(files);
  try {
    await f.manager.accept(await f.prepare());
    await new PluginService(f.manager).handle({
      type: "plugins.skillAvailability",
      plugin: "sample",
      name: "review",
      enabled: false,
      providers: ["claude", "codex", "cursor", "opencode"],
    });
    await f.reopen();
    for (const provider of ["codex", "claude", "cursor", "opencode"] as const) {
      const result = await projected(f, provider);
      try {
        await expect(result.read("review")).rejects.toMatchObject({ code: "ENOENT" });
        expect(await result.read("write")).toContain("Write the change.");
      } finally {
        await result.session.close();
      }
    }
    expect(await new PluginService(f.manager).handle({ type: "plugins.catalog" })).toMatchObject({
      components: expect.arrayContaining([
        expect.objectContaining({ name: "review", enabled: false }),
        expect.objectContaining({ name: "write", enabled: true }),
      ]),
    });
  } finally {
    await f.close();
  }
});

test("a skill's provider choice intersects with its plugin and disabling the plugin preserves the skill choice", async () => {
  const f = await fixture(files);
  try {
    await f.manager.accept(await f.prepare());
    const service = new PluginService(f.manager);
    await service.handle({
      type: "plugins.skillAvailability",
      plugin: "sample",
      name: "review",
      enabled: true,
      providers: ["codex"],
    });
    for (const provider of ["codex", "claude"] as const) {
      const result = await projected(f, provider);
      try {
        if (provider === "codex")
          expect(await result.read("review")).toContain("Check the behavior.");
        else await expect(result.read("review")).rejects.toMatchObject({ code: "ENOENT" });
        expect(await result.read("write")).toContain("Write the change.");
      } finally {
        await result.session.close();
      }
    }
    await service.handle({
      type: "plugins.availability",
      name: "sample",
      enabled: false,
      providers: ["claude"],
    });
    expect(await service.handle({ type: "plugins.catalog" })).toMatchObject({
      components: expect.arrayContaining([
        expect.objectContaining({
          name: "review",
          enabled: false,
          providers: [],
          skillAvailability: expect.objectContaining({ enabled: true, providers: ["codex"] }),
        }),
      ]),
    });
    await f.reopen();
    await new PluginService(f.manager).handle({
      type: "plugins.availability",
      name: "sample",
      enabled: true,
      providers: ["codex"],
    });
    const result = await projected(f, "codex");
    try {
      expect(await result.read("review")).toContain("Check the behavior.");
    } finally {
      await result.session.close();
    }
  } finally {
    await f.close();
  }
});

test("unknown skills cannot be configured and removing a plugin clears its skill choices", async () => {
  const f = await fixture(files);
  try {
    await f.manager.accept(await f.prepare());
    const service = new PluginService(f.manager);
    const request = {
      type: "plugins.skillAvailability",
      plugin: "sample",
      name: "review",
      enabled: false,
      providers: ["codex"],
    };
    await expect(service.handle({ ...request, name: "missing" })).rejects.toThrow(
      "Skill not installed",
    );
    await service.handle(request);
    await service.handle({ type: "plugins.remove", name: "sample" });
    await f.manager.accept(await f.prepare());
    const result = await projected(f, "codex");
    try {
      expect(await result.read("review")).toContain("Check the behavior.");
    } finally {
      await result.session.close();
    }
  } finally {
    await f.close();
  }
});

test("the catalog keeps an authored human title alongside the skill's invocation name", async () => {
  const f = await fixture({
    ...sampleFiles,
    "skills/review/SKILL.md":
      "---\nname: review\ndescription: Review changes\n---\n# Review a change\n\nCheck the behavior.\n",
  });
  try {
    await f.manager.accept(await f.prepare());
    expect(await new PluginService(f.manager).handle({ type: "plugins.catalog" })).toMatchObject({
      components: expect.arrayContaining([
        expect.objectContaining({ name: "review", title: "Review a change" }),
      ]),
    });
    expect(await f.manager.extensions("claude")).toContainEqual(
      expect.objectContaining({ name: "sample:review", title: "Review a change" }),
    );
  } finally {
    await f.close();
  }
});
