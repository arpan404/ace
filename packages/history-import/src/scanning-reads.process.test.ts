import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { environment, jsonl, claudeRecords, cwd } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("saved sessions remain readable while a progress consumer is busy", async () => {
  const env = await environment();
  cleanup = env.close;
  const home = join(env.root, "claude");
  for (let index = 0; index < 128; index++)
    await jsonl(
      join(home, "projects/p", `${index}.jsonl`),
      claudeRecords(`prompt-${index}`, `native-${index}`),
    );
  const service = await env.start([{ id: "account", provider: "claude", homeDir: home }]);
  await service.scan();
  let release: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scanning = service.scan(undefined, async () => {
    reached?.();
    await gate;
  });
  try {
    await paused;
    const page = await service.list({ type: "history.list", cwd, limit: 200 });
    expect(page.sessions).toHaveLength(128);
    expect(page.sessions.some((session) => session.title === "prompt-0")).toBe(true);
  } finally {
    release?.();
    await scanning;
  }
}, 10_000);

test("a busy progress consumer cannot stall scanning or its final inventory", async () => {
  const env = await environment();
  cleanup = env.close;
  const home = join(env.root, "claude");
  for (let index = 0; index < 128; index++)
    await jsonl(
      join(home, "projects/p", `${index}.jsonl`),
      claudeRecords(`prompt-${index}`, `native-${index}`),
    );
  const service = await env.start([{ id: "account", provider: "claude", homeDir: home }]);
  const gate = Promise.withResolvers<void>();
  const reports: number[] = [];
  try {
    const result = await service.scan(undefined, async (files) => {
      reports.push(files);
      await gate.promise;
    });
    expect(result.files).toBe(128);
    expect(reports.at(-1)).toBe(128);
    expect((await service.list({ type: "history.list", cwd, limit: 200 })).sessions).toHaveLength(
      128,
    );
  } finally {
    gate.resolve();
  }
});
