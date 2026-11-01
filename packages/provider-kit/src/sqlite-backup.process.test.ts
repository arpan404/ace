import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// A long-lived process: an idle 60s timer keeps the loop alive and nothing else runs.
// On Node before 26.9, a bare `await backup()` here resumes only when that timer fires.
const child = `
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
const { backup } = await import(process.env.BACKUP_MODULE);
const root = process.env.BACKUP_ROOT;
const keepAlive = setInterval(() => {}, 60_000);
const times = [];
for (const name of ["events.sqlite", "models.sqlite", "files.sqlite"]) {
  const writer = new DatabaseSync(join(root, name));
  writer.exec("CREATE TABLE content(value TEXT); INSERT INTO content VALUES('live')");
  writer.close();
  const source = new DatabaseSync(join(root, name), { readOnly: true });
  const started = performance.now();
  await backup(source, join(root, "copy-" + name));
  times.push(performance.now() - started);
  source.close();
  const copy = new DatabaseSync(join(root, "copy-" + name), { readOnly: true });
  if (copy.prepare("SELECT value FROM content").get()?.value !== "live") throw new Error("bad copy");
  copy.close();
}
clearInterval(keepAlive);
process.stdout.write(JSON.stringify(times));
`;

test("a backup settles promptly while an idle handle keeps the process alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-backup-settle-"));
  roots.push(root);
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", child], {
    env: {
      ...process.env,
      BACKUP_MODULE: new URL("./sqlite-backup.ts", import.meta.url).href,
      BACKUP_ROOT: root,
    },
    timeout: 50_000,
  });
  const times: number[] = JSON.parse(stdout);
  expect(times).toHaveLength(3);
  // Each copy takes about a millisecond. A stalled one waits for the 60s timer.
  for (const ms of times) expect(ms).toBeLessThan(5_000);
});
