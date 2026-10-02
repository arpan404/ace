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
    reviews: [response.review],
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
