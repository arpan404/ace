import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PluginService, inspectPackage, importPlugin } from "./index.ts";
import { fixture, git } from "./test-support.ts";

test("legacy oversized persisted reviews can be discovered, paged completely and cancelled after restart", async () => {
  const command = "x".repeat(8192);
  const f = await fixture({
    ".claude-plugin/plugin.json": JSON.stringify({
      name: "sample",
      hooks: Array(140).fill("hook.json"),
    }),
    "hook.json": JSON.stringify({ Stop: [{ command }] }),
  });
  try {
    const review = {
      id: "legacy",
      name: "sample",
      version: "0.0.0",
      commit: await git(f.repo, ["rev-parse", "HEAD"]),
      hash: (await inspectPackage(join(f.repo, "plugins/sample"))).hash,
      executions: Array.from({ length: 140 }, () => ({ kind: "hook", event: "Stop", command })),
      unsupported: ["Legacy diagnostic"],
    };
    f.manager.close();
    // A v1 registry snapshot written before the byte cap/summary-column migration.
    const database = new DatabaseSync(join(f.managerRoot, "registry.sqlite"));
    try {
      database.exec(
        "DROP TABLE reviews; CREATE TABLE reviews (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL)",
      );
      database
        .prepare("INSERT INTO reviews VALUES (?, ?, ?)")
        .run(review.id, review.name, JSON.stringify({ review, repository: f.repo, ref: "main" }));
    } finally {
      database.close();
    }
    await mkdir(join(f.managerRoot, "staging/legacy"));
    await writeFile(join(f.managerRoot, "staging/legacy/leftover"), "pending");
    await f.reopen();
    const service = new PluginService(f.manager);
    expect(await service.handle({ type: "plugins.list" })).toMatchObject({
      reviews: [{ id: "legacy", executionCount: 140, unsupportedCount: 1 }],
    });
    const entries = [];
    let offset: number | undefined = 0;
    do {
      const page = await service.handle({ type: "plugins.readReview", id: "legacy", offset });
      if (page.type !== "plugins.reviewPage") throw new Error("Missing page");
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(384 * 1024);
      entries.push(...page.entries);
      offset = page.nextOffset;
    } while (offset !== undefined);
    expect(entries).toEqual([
      ...review.executions.map((execution) => ({ type: "execution", execution })),
      { type: "diagnostic", message: "Legacy diagnostic" },
    ]);
    await service.handle({ type: "plugins.cancel", id: "legacy" });
    expect(await service.handle({ type: "plugins.list" })).toMatchObject({ reviews: [] });
    expect(await readdir(join(f.managerRoot, "staging"))).toEqual([]);
  } finally {
    await f.close();
  }
});

test("legacy consent exposes every argument from a native MCP file at the JSON limit", async () => {
  const args = Array.from({ length: 32 }, () => "x".repeat(8188));
  const mcp = JSON.stringify({ x: { command: "x", args } });
  // The old importer accepted this complete file; normalization adds a small envelope.
  expect(Buffer.byteLength(mcp)).toBe(262142);
  const files = { ".claude-plugin/plugin.json": '{"name":"sample"}', ".mcp.json": mcp };
  const f = await fixture(files);
  try {
    expect(importPlugin(files).manifest.mcpServers.x).toEqual({
      type: "stdio",
      command: "x",
      args,
      env: {},
      cwd: "${PLUGIN_ROOT}",
    });
    const review = {
      id: "legacy-limit",
      name: "sample",
      version: "0.0.0",
      commit: await git(f.repo, ["rev-parse", "HEAD"]),
      hash: (await inspectPackage(join(f.repo, "plugins/sample"))).hash,
      executions: [
        { kind: "stdio", name: "x", command: "x", args, env: {}, cwd: "${PLUGIN_ROOT}" },
      ],
      unsupported: [],
    };
    f.manager.close();
    const database = new DatabaseSync(join(f.managerRoot, "registry.sqlite"));
    try {
      database.exec(
        "DROP TABLE reviews; CREATE TABLE reviews (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL)",
      );
      database
        .prepare("INSERT INTO reviews VALUES (?, ?, ?)")
        .run(review.id, review.name, JSON.stringify({ review, repository: f.repo, ref: "main" }));
    } finally {
      database.close();
    }
    await cp(join(f.repo, "plugins/sample"), join(f.managerRoot, "staging", review.id), {
      recursive: true,
    });
    await f.reopen();
    const service = new PluginService(f.manager);
    expect(await service.handle({ type: "plugins.list" })).toMatchObject({
      reviews: [{ id: review.id, executionCount: 1 }],
    });
    const page = await service.handle({ type: "plugins.readReview", id: review.id });
    expect(page).toMatchObject({
      type: "plugins.reviewPage",
      entries: [{ type: "execution", execution: review.executions[0] }],
    });
    expect(page).not.toHaveProperty("nextOffset");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(385 * 1024);
    await service.handle({
      type: "plugins.accept",
      id: review.id,
      commit: review.commit,
      hash: review.hash,
    });
    expect(await service.handle({ type: "plugins.list" })).toMatchObject({
      reviews: [],
      installs: [{ name: "sample", commit: review.commit, hash: review.hash }],
    });
  } finally {
    await f.close();
  }
});
