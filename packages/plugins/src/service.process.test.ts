import { afterEach, expect, test } from "vitest";
import { PluginService } from "./index.ts";
import { fixture } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
test("wire requests expose pending reviews and only install the explicitly accepted version", async () => {
  const f = await fixture();
  cleanups.push(f.close);
  const service = new PluginService(f.manager);
  const response = await service.handle({
    type: "plugins.prepare",
    repository: f.repo,
    ref: "main",
    name: "sample",
  });
  if (response.type !== "plugins.review") throw new Error("Expected review");
  expect(await service.handle({ type: "plugins.list" })).toEqual({
    type: "plugins.list",
    installs: [],
    reviews: [
      {
        id: response.review.id,
        name: response.review.name,
        version: response.review.version,
        commit: response.review.commit,
        hash: response.review.hash,
        executionCount: response.review.executions.length,
        unsupportedCount: response.review.unsupported.length,
      },
    ],
  });
  await expect(
    service.handle({
      type: "plugins.accept",
      id: response.review.id,
      commit: response.review.commit,
      hash: "0".repeat(64),
    }),
  ).rejects.toThrow("Consent");
  const installed = await service.handle({
    type: "plugins.accept",
    id: response.review.id,
    commit: response.review.commit,
    hash: response.review.hash,
  });
  expect(installed).toMatchObject({
    type: "plugins.installed",
    install: { hash: response.review.hash },
  });
  expect(await service.handle({ type: "plugins.list" })).toMatchObject({
    installs: [{ name: "sample" }],
    reviews: [],
  });
  const update = await service.handle({ type: "plugins.update", name: "sample" });
  if (update.type !== "plugins.review") throw new Error("Expected update review");
  expect(await service.handle({ type: "plugins.cancel", id: update.review.id })).toEqual({
    type: "plugins.cancelled",
    id: update.review.id,
  });
  expect(await service.handle({ type: "plugins.remove", name: "sample" })).toEqual({
    type: "plugins.removed",
    name: "sample",
  });
  expect(await service.handle({ type: "plugins.list" })).toEqual({
    type: "plugins.list",
    installs: [],
    reviews: [],
  });
});
test("malformed requests cannot mutate accepted installs or escape a package path", async () => {
  const f = await fixture();
  cleanups.push(f.close);
  const service = new PluginService(f.manager);
  await expect(
    service.handle({ type: "plugins.prepare", repository: f.repo, ref: "main", name: "../evil" }),
  ).rejects.toThrow();
  await expect(
    service.handle({
      type: "plugins.accept",
      id: "../../outside",
      commit: "0".repeat(40),
      hash: "0".repeat(64),
    }),
  ).rejects.toThrow();
  await expect(
    service.handle({ type: "plugins.remove", name: "sample", force: true }),
  ).rejects.toThrow();
  await expect(service.handle({ type: "plugins.unknown" })).rejects.toThrow();
  expect(f.manager.list()).toEqual([]);
});

test("oversized execution reviews fail before persistence and leave the wire list usable", async () => {
  const f = await fixture({
    ".claude-plugin/plugin.json": JSON.stringify({
      name: "sample",
      hooks: Array(140).fill("hook.json"),
    }),
    "hook.json": JSON.stringify({ Stop: [{ command: "x".repeat(8192) }] }),
  });
  cleanups.push(f.close);
  const service = new PluginService(f.manager);
  await expect(
    service.handle({ type: "plugins.prepare", repository: f.repo, ref: "main", name: "sample" }),
  ).rejects.toThrow("Review exceeds byte limit");
  expect(await service.handle({ type: "plugins.list" })).toMatchObject({ reviews: [] });
  await f.reopen();
  expect(f.manager.pending()).toEqual([]);
});
test("large collections expose bounded review summaries and complete paged consent details", async () => {
  const f = await fixture({
    ".claude-plugin/plugin.json": JSON.stringify({
      name: "sample",
      hooks: Array(30).fill("hook.json"),
    }),
    "hook.json": JSON.stringify({ Stop: [{ command: "x".repeat(8192) }] }),
  });
  cleanups.push(f.close);
  const service = new PluginService(f.manager);
  for (let index = 0; index < 5; index++) await f.prepare();
  const list = await service.handle({ type: "plugins.list" });
  expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThan(128 * 1024);
  expect(list).toMatchObject({
    reviews: Array.from({ length: 5 }, () => ({ executionCount: 30 })),
  });
  const review = f.manager.pending()[0];
  if (!review) throw new Error("Missing review");
  const entries = [];
  let offset: number | undefined = 0;
  do {
    const page = await service.handle({ type: "plugins.readReview", id: review.id, offset });
    if (page.type !== "plugins.reviewPage") throw new Error("Missing review page");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
    entries.push(...page.entries);
    offset = page.nextOffset;
  } while (offset !== undefined);
  expect(entries).toEqual(review.executions.map((execution) => ({ type: "execution", execution })));
  await service.handle({ type: "plugins.cancel", id: review.id });
  expect(f.manager.pending()).toHaveLength(4);
});

test("a single large accepted execution remains completely readable after reopening", async () => {
  const args = Array.from({ length: 25 }, (_, index) => `${index}:` + "x".repeat(8188));
  const f = await fixture({
    "ace-plugin.json": JSON.stringify({
      schemaVersion: 1,
      name: "sample",
      version: "1",
      mcpServers: { large: { type: "stdio", command: "echo", args } },
    }),
  });
  cleanups.push(f.close);
  const review = await f.prepare();
  await f.reopen();
  const service = new PluginService(f.manager);
  const page = await service.handle({ type: "plugins.readReview", id: review.id });
  expect(page).toMatchObject({
    type: "plugins.reviewPage",
    entries: [{ type: "execution", execution: { kind: "stdio", command: "echo", args } }],
  });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(384 * 1024);
});

test("a repository's marketplace lists its plugins at the default branch, staging nothing", async () => {
  const f = await fixture();
  cleanups.push(f.close);
  const service = new PluginService(f.manager);
  expect(await service.handle({ type: "plugins.marketplace", repository: f.repo })).toEqual({
    type: "plugins.marketplace",
    ref: "HEAD",
    plugins: [{ name: "sample" }],
  });
  expect(await service.handle({ type: "plugins.list" })).toEqual({
    type: "plugins.list",
    installs: [],
    reviews: [],
  });

  const review = await service.handle({
    type: "plugins.prepare",
    repository: f.repo,
    ref: "HEAD",
    name: "sample",
  });
  if (review.type !== "plugins.review") throw new Error("Expected review");
  await service.handle({
    type: "plugins.accept",
    id: review.review.id,
    commit: review.review.commit,
    hash: review.review.hash,
  });
  // The install remembers where it came from, so Update and the plugin page can say. It is
  // its own request: a list reply keeps the shape older clients parse strictly.
  expect(await service.handle({ type: "plugins.origins" })).toEqual({
    type: "plugins.origins",
    origins: [{ name: "sample", repository: f.repo, ref: "HEAD" }],
  });
  const list = await service.handle({ type: "plugins.list" });
  if (list.type !== "plugins.list") throw new Error("Expected list");
  expect(Object.keys(list.installs[0] ?? {}).toSorted()).toEqual([
    "acceptedAt",
    "commit",
    "hash",
    "name",
    "version",
  ]);
});
