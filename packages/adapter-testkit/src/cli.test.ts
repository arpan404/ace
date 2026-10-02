import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const fixture = path("./__fixtures__/tiny.jsonl");
const adapter = path("./__fixtures__/cli-adapter.ts");
const cli = path("./cli.ts");
describe("timeline command", () => {
  it("prints checkpoint states and final counts through the documented Bun workspace command", () => {
    const child = spawnSync(
      "bun",
      [
        "run",
        "--filter",
        "@ace/adapter-testkit",
        "timeline",
        fixture,
        "--adapter",
        adapter,
        "--expect",
        path("./__fixtures__/tiny.expect.json"),
      ],
      { cwd: path("../../../"), encoding: "utf8" },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('"t":60,"thread":{"state":"done"}');
    expect(child.stdout).toContain('"resolved":1');
    expect(child.stdout).toContain('"expired":1');
    expect(child.stdout).toContain('"final":{"thread":{"state":"done"},"agents":2');
  });
  it("rejects a negative CLI checkpoint with a clear error", () => {
    const child = spawnSync(
      process.execPath,
      [cli, fixture, "--adapter", adapter, "--checkpoint=-1"],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("checkpoint times must be nonnegative integers");
    expect(child.stdout).toBe("");
  });
  it.each([
    { change: 'provider: "claude"', error: "fixture provider codex does not match adapter claude" },
    { change: 'provider: "invalid"', error: "provider" },
    { change: "createTranslator: null", error: "createTranslator" },
    { change: "capabilities: null", error: "capabilities" },
    { change: "openSession: null", error: "openSession" },
    { change: "createTranslator: () => ({ translate() { return []; } })", error: "tick" },
    { change: "createTranslator: () => ({ tick() { return []; } })", error: "translate" },
  ])(
    "rejects an imported adapter with $change before printing a timeline",
    async ({ change, error }) => {
      const dir = await mkdtemp(join(tmpdir(), "ace-cli-adapter-"));
      const modulePath = join(dir, "adapter.mjs");
      try {
        await writeFile(
          modulePath,
          `import base from ${JSON.stringify(pathToFileURL(adapter).href)}; export default { ...base, ${change} };`,
        );
        const child = spawnSync(process.execPath, [cli, fixture, "--adapter", modulePath], {
          encoding: "utf8",
        });
        expect(child.status).toBe(1);
        expect(child.stdout).toBe("");
        expect(child.stderr).toContain(error);
        if (change !== 'provider: "claude"')
          expect(child.stderr).toContain(`adapter module ${modulePath}`);
        if (error === "tick" || error === "translate")
          expect(child.stderr).toContain("invalid translator");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
