import { afterEach, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openHistory } from "./index.ts";
import { ReaderProcess, systemReaderRuntime } from "./reader-process.ts";
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
  older.close();
  // The catalog uses WAL, so a write may sit in the -wal file rather than the index itself.
  const walPath = `${indexPath}-wal`;
  const wal = async () => (existsSync(walPath) ? readFile(walPath) : Buffer.alloc(0));
  const before = await readFile(indexPath);
  const walBefore = await wal();
  let launches = 0;
  await expect(
    openHistory(
      { indexPath, instances: homes },
      // The real reader process: its refusal has to cross a process boundary intact.
      (url, options) => {
        launches++;
        return new ReaderProcess(url, options, systemReaderRuntime());
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
  // Byte for byte: the refusal neither migrated nor rewrote the index.
  expect((await readFile(indexPath)).equals(before)).toBe(true);
  expect((await wal()).equals(walBefore)).toBe(true);
});
