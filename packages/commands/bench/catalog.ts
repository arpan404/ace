import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCatalog, CommandFiles, parseMarkdown, type Target } from "../src/index.ts";
const catalog = new CommandCatalog(Date.now),
  target: Target = { provider: "codex", instance: "codex", session: "bench" };
for (let i = 0; i < 1000; i++)
  catalog.replaceSource(
    String(i),
    parseMarkdown(
      `---\nname: review-${i}\narguments:\n  file: {type: string, default: app.ts}\n---\nReview {{file}}`,
      { source: String(i), name: "unused", scope: "user", format: "library" },
    ),
  );
function measure(name: string, count: number, work: () => void) {
  const start = performance.now();
  for (let i = 0; i < count; i++) work();
  const elapsed = performance.now() - start;
  process.stdout.write(
    `${name}: ${((elapsed * 1000) / count).toFixed(2)} us/op, ${((count * 1000) / elapsed).toFixed(0)} ops/s\n`,
  );
}
const replacement = parseMarkdown("replacement", {
  source: "updated",
  name: "new",
  scope: "user",
  format: "library",
});
measure("replace one source in 1000 commands", 10000, () => {
  catalog.replaceSource("updated", replacement);
});
measure("resolve typed template", 10000, () => {
  catalog.resolve(target, "1#review-1", { file: "src/app.ts" });
});
measure("fuzzy list top 50 of 1000", 1000, () => {
  catalog.list(target, "rv", 50);
});
const home = await realpath(await mkdtemp(join(tmpdir(), "ace-command-bench-")));
const root = join(home, "prompts");
await mkdir(root);
for (let i = 0; i < 100; i++) await writeFile(join(root, `${i}.md`), "body");
const files = new CommandFiles(
  new CommandCatalog(Date.now),
  [{ path: root, format: "library", scope: "user" }],
  { schedule: () => () => {} },
);
try {
  await files.start();
  const recoveryStart = performance.now();
  for (let i = 0; i < 100; i++) await files.reconcile();
  process.stdout.write(
    `recovery batch of up to 32 metadata checks: ${((performance.now() - recoveryStart) * 10).toFixed(2)} us/op\n`,
  );
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    files.invalidate(join(root, "1.md"));
    await files.flush();
  }
  process.stdout.write(
    `incremental filesystem refresh among 100 files: ${((performance.now() - start) * 10).toFixed(2)} us/op\n`,
  );
} finally {
  await files.close();
  await rm(home, { recursive: true, force: true });
}
process.stdout.write(`Peak RSS: ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`);
