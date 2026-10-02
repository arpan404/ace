import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "@ace/redaction";
import {
  createDoctorChecks,
  createSystemProbes,
  runDoctor,
  formatDoctor,
  writeSupportBundle,
  recentThreadEvents,
} from "@ace/diagnostics";
import type { Config } from "./config.ts";
export async function diagnosticsCli(args: string[], config: Config): Promise<boolean> {
  if (args[0] === "--") args = args.slice(1);
  if (args[0] !== "doctor" && args[0] !== "support-bundle") return false;
  const redact = createRedactor({ home: homedir(), env: process.env });
  const report = await runDoctor(
    createDoctorChecks(
      createSystemProbes({ dataDir: config.dataDir, port: config.port, env: process.env }),
    ),
    { now: Date.now },
  );
  if (args[0] === "doctor") {
    if (args.slice(1).some((arg) => arg !== "--json"))
      throw new Error("Usage: ace doctor [--json]");
    process.stdout.write(
      redact(args.includes("--json") ? JSON.stringify(report) : formatDoctor(report)) + "\n",
    );
    process.exitCode = report.checks.some((check) => check.status === "fail") ? 1 : 0;
    return true;
  }
  const path = args[1];
  if (!path || path.startsWith("--") || args.slice(2).some((arg) => arg !== "--include-threads"))
    throw new Error("Usage: ace support-bundle PATH [--include-threads]");
  const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
  let created = false;
  output.once("open", () => {
    created = true;
  });
  try {
    await writeSupportBundle({
      logsDirectory: join(config.dataDir, "logs"),
      temporaryRoot: tmpdir(),
      output,
      report,
      versions: {
        node: process.version,
        nodeAbi: process.versions.modules ?? "unknown",
        platform: process.platform,
        arch: process.arch,
        ace: "development",
        ...Object.fromEntries(
          report.checks
            .filter((check) => check.id.startsWith("provider."))
            .map((check) => [check.id, check.message]),
        ),
      },
      settings: config,
      redact,
      includeThreads: args.includes("--include-threads"),
      threads: () => recentThreadEvents(join(config.dataDir, "events.sqlite")),
    });
  } catch (error) {
    if (created) await rm(path, { force: true });
    throw error;
  }
  process.stdout.write(`Support bundle: ${path}\n`);
  return true;
}
