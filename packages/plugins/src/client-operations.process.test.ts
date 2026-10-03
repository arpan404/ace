import { expect, test } from "vitest";
import { PluginService } from "./index.ts";
import { fixture } from "./test-support.ts";
test("catalog availability survives restart and filters the next provider session", async () => {
  const f = await fixture();
  try {
    const review = await f.prepare();
    await f.manager.accept(review);
    const service = new PluginService(f.manager);
    const catalog = await service.handle({ type: "plugins.catalog", offset: 0, limit: 50 });
    expect(catalog).toMatchObject({
      type: "plugins.catalog",
      components: expect.arrayContaining([
        expect.objectContaining({
          plugin: "sample",
          name: "review",
          kind: "skill",
          path: "skills/review/SKILL.md",
          description: "",
          enabled: true,
          providers: expect.arrayContaining(["codex"]),
        }),
      ]),
    });
    await service.handle({
      type: "plugins.availability",
      name: "sample",
      enabled: true,
      providers: ["codex"],
    });
    await f.reopen();
    expect((await f.manager.selected("claude")).length).toBe(0);
    expect((await f.manager.selected("codex")).map((entry) => entry.install.name)).toEqual([
      "sample",
    ]);
    f.manager.configure({ name: "sample", enabled: false, providers: ["codex"] });
    expect(await f.manager.selected("codex")).toEqual([]);
  } finally {
    await f.close();
  }
});

test("editing source creates a new pinned review while the accepted version stays immutable", async () => {
  const f = await fixture();
  try {
    const initial = await f.prepare();
    await f.manager.accept(initial);
    const service = new PluginService(f.manager);
    const source = await service.handle({
      type: "plugins.source",
      name: "sample",
      path: "skills/review/SKILL.md",
      offset: 0,
      limit: 65536,
    });
    if (source.type !== "plugins.source") throw new Error("Expected source");
    const text = "---\nname: review\ndescription: Review edits\n---\nCheck 雪.\n";
    const response = await service.handle({
      type: "plugins.edit",
      name: "sample",
      path: "skills/review/SKILL.md",
      expectedHash: source.hash,
      text,
    });
    if (response.type !== "plugins.review") throw new Error("Expected edited review");
    expect(response.review.hash).not.toBe(initial.hash);
    const unchanged = await service.handle({
      type: "plugins.source",
      name: "sample",
      path: "skills/review/SKILL.md",
      offset: 0,
      limit: 65536,
    });
    expect(unchanged).toMatchObject({
      type: "plugins.source",
      hash: source.hash,
      text: source.text,
    });
    await expect(
      service.handle({
        type: "plugins.accept",
        id: response.review.id,
        commit: response.review.commit,
        hash: initial.hash,
      }),
    ).rejects.toThrow("Consent");
    await service.handle({
      type: "plugins.accept",
      id: response.review.id,
      commit: response.review.commit,
      hash: response.review.hash,
    });
    const edited = await service.handle({
      type: "plugins.source",
      name: "sample",
      path: "skills/review/SKILL.md",
      offset: 0,
      limit: 65536,
    });
    expect(edited).toMatchObject({ type: "plugins.source", text });
    await expect(
      service.handle({
        type: "plugins.edit",
        name: "sample",
        path: "skills/review/SKILL.md",
        expectedHash: source.hash,
        text: source.text,
      }),
    ).rejects.toThrow("Source changed");
  } finally {
    await f.close();
  }
});
