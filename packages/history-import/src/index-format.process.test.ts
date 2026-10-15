import { afterEach, expect, test } from "vitest";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openHistory } from "./index.ts";
import { environment, jsonl, claudeRecords } from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

test("an index in an older format is refused once, untouched, instead of restarting the reader", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const homeDir = join(env.root, "claude");
  const homes = [{ id: "account", provider: "claude" as const, homeDir }];
  await jsonl(join(homeDir, "projects/p/session.jsonl"), claudeRecords());
  const original = await env.start(homes);
  await original.scan();
  await original.close();
  const indexPath = join(env.root, "ace/index.sqlite");
  const older = new DatabaseSync(indexPath);
  older.prepare("UPDATE catalog_settings SET value='4' WHERE key='format'").run();
  const sources = older.prepare("SELECT count(*) AS n FROM sources").get()?.n;
  older.close();
  let launches = 0;
  await expect(
    openHistory(
      { indexPath, instances: homes },
      (url, options) => {
        launches++;
        return new Worker(url, options);
      },
      {
        delay: (run) => {
          const timer = setTimeout(run, 0);
          return () => clearTimeout(timer);
        },
      },
    ),
  ).rejects.toMatchObject({
    code: "incompatible-data",
    path: indexPath,
    message: expect.stringMatching(/format 4.*reads format 5.*move that file aside/),
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(launches).toBe(1);
  const after = new DatabaseSync(indexPath, { readOnly: true });
  try {
    expect(
      after.prepare("SELECT value FROM catalog_settings WHERE key='format'").get()?.value,
    ).toBe("4");
    expect(after.prepare("SELECT count(*) AS n FROM sources").get()?.n).toBe(sources);
  } finally {
    after.close();
  }
});
