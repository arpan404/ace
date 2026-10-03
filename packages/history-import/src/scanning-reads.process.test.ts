import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { environment, jsonl, claudeRecords, cwd } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("saved sessions remain readable while a worker scan is paused at a progress boundary", async () => {
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

test("closing cancels a scan held at progress without requiring its caller to release the gate", async () => {
  const env = await environment();
  cleanup = env.close;
  const home = join(env.root, "claude");
  for (let index = 0; index < 64; index++)
    await jsonl(
      join(home, "projects/p", `${index}.jsonl`),
      claudeRecords(`prompt-${index}`, `native-${index}`),
    );
  const homes = [{ id: "account", provider: "claude" as const, homeDir: home }];
  const service = await env.start(homes);
  await service.scan();
  const gate = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<void>();
  const scanning = service.scan(undefined, async () => {
    paused.resolve();
    await gate.promise;
  });
  const cancelled = expect(scanning).rejects.toThrow();
  try {
    await paused.promise;
    // Keep the acknowledgement withheld until close and rejection have both completed.
    await service.close();
    await cancelled;
    const reopened = await env.start(homes);
    expect((await reopened.list({ type: "history.list", cwd, limit: 200 })).sessions).toHaveLength(
      64,
    );
  } finally {
    gate.resolve();
  }
}, 10_000);
