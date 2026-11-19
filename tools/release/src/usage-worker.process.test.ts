import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "@ace/daemon";
import { StorageUsage } from "@ace/protocol";
import { bundleDaemon } from "@ace/release";
import { expect, test } from "vitest";

test("the packaged usage scanner measures data without source files or changing the measured files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-usage-bundle-"));
  const data = join(root, "data");
  const contents = "usage measurement keeps this log intact\n";
  try {
    await mkdir(join(data, "logs"), { recursive: true });
    await writeFile(join(data, "logs", "fixture.jsonl"), contents);
    const store = new Store(join(data, "events.sqlite"));
    await store.close();
    const source = resolve(
      import.meta.dirname,
      "../../..",
      "apps/daemon/src/storage/usage-scanner.ts",
    );
    const entry = join(root, "entry.ts");
    await writeFile(
      entry,
      `import { UsageScanner } from ${JSON.stringify(source)};
const scanner = new UsageScanner(${JSON.stringify(data)});
try { console.log(JSON.stringify(await scanner.scan())); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally { await scanner.close(); }
`,
    );
    await bundleDaemon(resolve(import.meta.dirname, "../../.."), root, "", undefined, entry);
    await rm(entry);
    const result = await promisify(execFile)(
      process.execPath,
      ["--no-extra-info-on-fatal-exception", join(root, "ace.mjs")],
      {
        cwd: root,
        timeout: 30_000,
        maxBuffer: 65_536,
      },
    ).catch((cause: unknown) => {
      if (cause instanceof Error && "stderr" in cause && typeof cause.stderr === "string")
        throw new Error(
          cause.stderr
            .split("\n")
            .filter((line) => line.length < 1000)
            .join("\n"),
        );
      throw cause;
    });
    const usage = StorageUsage.parse(JSON.parse(result.stdout.trim()));
    expect(usage.complete).toBe(true);
    expect(usage.categories.find((category) => category.kind === "logs")).toEqual({
      kind: "logs",
      bytes: Buffer.byteLength(contents),
      items: 1,
    });
    expect(usage.databaseBytes).toBeGreaterThan(0);
    expect(await readFile(join(data, "logs", "fixture.jsonl"), "utf8")).toBe(contents);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
