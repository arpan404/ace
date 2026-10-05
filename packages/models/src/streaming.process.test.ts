import { expect, test } from "vitest";
import { spawnSupervised } from "@ace/provider-kit/process";
import { createModelDiscovery, normalizeOpenCode, OpenCodeParser } from "./index.ts";
import { codexPayload, fakeCli, instance, workspace } from "./testing/support.ts";

test("stderr flood rejects otherwise valid metadata and reaps the CLI", async () => {
  const work = await workspace();
  const config = {
    ...instance(),
    cwd: work.path,
    args: [await fakeCli(work.path)],
    env: { FAKE_PROVIDER: "codex", FAKE_PAYLOAD: JSON.stringify(codexPayload()) },
  };
  let reaped = false;
  const discovery = createModelDiscovery({
    spawn(options) {
      const proc = spawnSupervised(options);
      void proc.exited.then(() => {
        reaped = true;
      });
      return proc;
    },
  });
  try {
    await expect(
      discovery(
        { ...config, env: { ...config.env, FAKE_STDERR: "1" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(reaped).toBe(true);
  } finally {
    await work.close();
  }
});

test("OpenCode rejects an incomplete final object after complete earlier models", async () => {
  expect(() =>
    normalizeOpenCode(
      'local/a\n{"id":"a","providerID":"local","name":"A"}\nlocal/b\n{',
      instance("opencode"),
    ),
  ).toThrow("Incomplete");
});

test("incremental OpenCode parsing preserves completed rows across successive objects", () => {
  const parser = new OpenCodeParser(instance("opencode"));
  for (const line of [
    "local/a",
    "{",
    '  "id": "a",',
    '  "providerID": "local",',
    '  "name": "A"',
    "}",
    "local/b",
    '{"id":"b","providerID":"local","name":"B"}',
  ])
    parser.push(line);
  expect(parser.finish().map((row) => [row.id, row.nativeModelId])).toEqual([
    ["local/a", "local/a"],
    ["local/b", "local/b"],
  ]);
});

test("incremental OpenCode metadata refuses more than the byte bound", () => {
  const parser = new OpenCodeParser(instance("opencode"));
  parser.push("local/a");
  expect(() => parser.push("x".repeat(4 * 1024 * 1024))).toThrow("limit");
});
