import { expect, test } from "vitest";
import { PluginService, PluginManager } from "./index.ts";
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

test("inline command pages expose their owning manifest and edits require a new accepted review", async () => {
  const f = await fixture({
    ".claude-plugin/plugin.json": JSON.stringify({
      name: "sample",
      version: "1.0",
      extra: "retained",
      commands: { hello: { content: "雪 says hello!", description: "Greeting", future: 42 } },
    }),
  });
  try {
    await f.manager.accept(await f.prepare());
    const service = new PluginService(f.manager);
    const path = ".ace-inline/commands/hello.md";
    expect(await service.handle({ type: "plugins.catalog", offset: 0, limit: 50 })).toMatchObject({
      components: [{ name: "hello", path, description: "Greeting" }],
    });
    let offset = 0,
      text = "";
    const initial = await f.manager.source("sample", path, 0, 4);
    for (;;) {
      const page = await f.manager.source("sample", path, offset, 4);
      expect(page).toMatchObject({
        virtual: true,
        manifestPath: ".claude-plugin/plugin.json",
        hash: initial.hash,
      });
      text += page.text;
      if (page.nextOffset === page.bytes) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(text).toBe("雪 says hello!");
    expect(initial.hash).toBe(createHash("sha256").update(text).digest("hex"));
    expect(JSON.parse(await readFile(initial.path, "utf8"))).toMatchObject({
      commands: { hello: { content: text } },
    });
    const edited = await f.manager.edit({
      name: "sample",
      path,
      expectedHash: initial.hash,
      text: "New 雪",
    });
    expect((await f.manager.source("sample", path, 0, 65536)).text).toBe(text);
    await f.manager.accept(edited);
    const accepted = await f.manager.source("sample", path, 0, 65536);
    expect(accepted.text).toBe("New 雪");
    expect(JSON.parse(await readFile(accepted.path, "utf8"))).toMatchObject({
      extra: "retained",
      commands: {
        hello: { content: "New 雪", description: "Greeting", future: 42 },
      },
    });
    expect((await f.manager.selected("codex"))[0]?.text[path]).toBe("New 雪");
    await expect(
      f.manager.edit({ name: "sample", path, expectedHash: initial.hash, text }),
    ).rejects.toThrow("Source changed");
  } finally {
    await f.close();
  }
});

test("warm catalog pages survive unavailable package files while execution still verifies integrity", async () => {
  const f = await fixture();
  try {
    const install = await f.manager.accept(await f.prepare());
    const first = await f.manager.catalog(0, 1);
    expect(first).toMatchObject({ components: [{ name: "review" }], nextOffset: 1 });
    const root = join(f.managerRoot, "versions", install.hash),
      held = join(f.root, "held");
    await rename(root, held);
    try {
      expect(await f.manager.catalog(1, 1)).toMatchObject({
        components: [{ name: "check" }],
        nextOffset: 2,
      });
      await expect(f.manager.selected("codex")).rejects.toThrow();
    } finally {
      await rename(held, root);
    }
    f.manager.configure({ name: "sample", enabled: false, providers: ["codex"] });
    expect(await f.manager.catalog(1, 1)).toMatchObject({
      components: [{ name: "check", enabled: false }],
    });
    const peer = await PluginManager.open({
      root: f.managerRoot,
      now: () => 124,
      id: () => "peer",
    });
    try {
      await peer.remove("sample");
    } finally {
      peer.close();
    }
    expect(await f.manager.catalog(0, 50)).toEqual({ components: [] });
  } finally {
    await f.close();
  }
});

import { createHash } from "node:crypto";
import { readFile, rename, mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";

test("cached catalog metadata cannot authorize source reads through a replaced parent symlink", async () => {
  const f = await fixture();
  try {
    const install = await f.manager.accept(await f.prepare());
    await f.manager.catalog(0, 50);
    const skills = join(f.managerRoot, "versions", install.hash, "skills");
    const held = join(f.root, "original-skills"),
      outside = join(f.root, "outside");
    await mkdir(join(outside, "review"), { recursive: true });
    await writeFile(join(outside, "review", "SKILL.md"), "Do not disclose outside content");
    await rename(skills, held);
    await symlink(outside, skills);
    await expect(f.manager.source("sample", "skills/review/SKILL.md", 0, 65536)).rejects.toThrow(
      "Symlink forbidden",
    );
  } finally {
    await f.close();
  }
});
