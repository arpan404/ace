import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  it("reports invalid CLI times as a failed command", () => {
    const child = spawnSync(
      process.execPath,
      [cli, fixture, "--adapter", adapter, "--checkpoint=-1"],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("checkpoint times must be nonnegative integers");
    expect(child.stdout).toBe("");
  });
});
