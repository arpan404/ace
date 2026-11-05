import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { bundleDaemon } from "@ace/release";

// The package runs on Bun, as releases do: off Linux the reader's memory sampler is bun:ffi. The
// reader is found with pgrep and ps, which Windows doesn't have.
test.skipIf(!("bun" in process.versions) || process.platform === "win32")(
  "the packaged daemon reads saved conversations through a reader process of its own",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-history-reader-bundle-"));
    const repo = resolve(import.meta.dirname, "../../..");
    const home = join(root, "claude");
    const id = "11111111-1111-4111-8111-111111111111";
    try {
      await mkdir(join(home, "projects/p"), { recursive: true });
      await writeFile(
        join(home, "projects/p", `${id}.jsonl`),
        JSON.stringify({
          type: "user",
          sessionId: id,
          cwd: "/workspace",
          message: { role: "user", content: "packaged prompt" },
        }) + "\n",
      );
      const entry = join(root, "entry.ts");
      // Reports the titles it lists, and the command line and memory reading of its reader.
      await writeFile(
        entry,
        `
import { execFileSync } from "node:child_process";
import { openHistory } from ${JSON.stringify(join(repo, "packages/history-import/src/index.ts"))};
import { residentSampler } from ${JSON.stringify(join(repo, "packages/provider-kit/src/resident-memory.ts"))};
const service = await openHistory({
  indexPath: ${JSON.stringify(join(root, "index.sqlite"))},
  instances: [{ id: "claude", provider: "claude", homeDir: ${JSON.stringify(home)} }],
});
try {
  await service.scan();
  const page = await service.list({ type: "history.list", cwd: "/workspace" });
  const reader = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).trim();
  const command = execFileSync("ps", ["-o", "command=", "-p", reader], { encoding: "utf8" }).trim();
  const resident = await residentSampler()(Number(reader));
  console.log(JSON.stringify({ titles: page.sessions.map((s) => s.title), reader: command, resident }));
} finally {
  await service.close();
}
`,
      );
      await bundleDaemon(repo, root, "", undefined, entry);
      await rm(entry);
      const result = await promisify(execFile)(process.execPath, [join(root, "ace.mjs")], {
        cwd: root,
        timeout: 60_000,
        maxBuffer: 65536,
      });
      const report = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
      expect(report.titles).toEqual(["packaged prompt"]);
      // The bundled reader entry, not a source file, runs as the daemon's child.
      expect(report.reader).toContain(join(root, "history-import-worker.mjs"));
      // The watchdog's sampler works in the package, which carries no koffi: it is bun:ffi.
      expect(report.resident).toBeGreaterThan(1024 * 1024);
      const shipped = await readdir(root, { recursive: true });
      expect(shipped.filter((path) => path.includes("koffi"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
