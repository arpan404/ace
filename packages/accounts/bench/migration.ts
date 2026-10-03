import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstance, migrateSession } from "../src/index.ts";
const root = await mkdtemp(join(tmpdir(), "ace-copy-bench-"));
const from = createInstance({
  id: "from",
  provider: "codex",
  label: "from",
  homeDir: join(root, "from"),
});
const to = createInstance({ id: "to", provider: "codex", label: "to", homeDir: join(root, "to") });
const id = "11111111-1111-4111-8111-111111111111";
const relative = `sessions/rollout-${id}.jsonl`;
const source = join(from.homeDir, relative);
const target = join(to.homeDir, relative);
async function digest(path: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path, { highWaterMark: 65536 }), hash);
  return hash.digest("hex");
}
try {
  await mkdir(join(from.homeDir, "sessions"), { recursive: true });
  await mkdir(to.homeDir);
  async function* content() {
    yield `${JSON.stringify({ type: "session_meta", payload: { id } })}\n`;
    const chunk = Buffer.alloc(65536, 120);
    for (let i = 0; i < 1024; i++) yield chunk;
  }
  await pipeline(content(), createWriteStream(source));
  const rss = process.memoryUsage().rss;
  const start = performance.now();
  const result = await migrateSession(
    { provider: "codex", nativeSessionId: id, from, to },
    { acquire: async () => ({ release: async () => {} }) },
  );
  const elapsed = performance.now() - start;
  if (result.status !== "migrated" || (await digest(source)) !== (await digest(target)))
    throw new Error("Copy failed verification");
  process.stdout.write(
    `64 MiB copy: ${elapsed.toFixed(2)} ms, ${(64 / (elapsed / 1000)).toFixed(1)} MiB/s, RSS delta ${((process.memoryUsage().rss - rss) / 1048576).toFixed(1)} MiB, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
