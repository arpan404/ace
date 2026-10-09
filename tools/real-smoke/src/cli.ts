import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { scrubber } from "./report.ts";
import { homedir } from "node:os";
import { defaultSource, runSmoke } from "./runtime.ts";
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "home-source": { type: "string" },
    fixture: { type: "boolean", default: false },
    "max-threads": { type: "string", default: "40" },
    "scan-timeout-ms": { type: "string", default: "120000" },
  },
});
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const out = values.out ?? join("/tmp/ace-smoke", sha);
const source = (values["home-source"] ?? defaultSource()).replace(/^~\//, homedir() + "/");
try {
  const report = await runSmoke({
    fixture: values.fixture,
    out,
    homeSource: source,
    maxThreads: z.coerce.number().int().min(1).max(200).parse(values["max-threads"]),
    scanTimeoutMs: z.coerce.number().int().min(1000).max(600000).parse(values["scan-timeout-ms"]),
    stepTimeoutMs: 15000,
  });
  process.stdout.write(
    `${report.failures.length ? "FAIL" : "PASS"}: ${report.failures.length} failures. ${out}/summary.md\n`,
  );
  process.exitCode = report.completed && !report.failures.length ? 0 : 1;
} catch (error) {
  process.stderr.write(scrubber()(error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
