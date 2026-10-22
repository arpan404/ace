import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import { formatDoctor, writeSupportBundle, recentThreadEvents } from "@ace/diagnostics";
import { collectRawDoctorReport, redactDoctorReport } from "./diagnostics-report.ts";
import type { Config } from "./config.ts";
export async function diagnosticsCli(
  args: string[],
  config: Config,
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): Promise<boolean> {
  if (args[0] === "--") args = args.slice(1);
  if (args[0] !== "doctor" && args[0] !== "support-bundle") return false;
  const context = { home: homedir(), env: process.env };
  const redact = createDiagnosticRedactor(context);
  const raw = await collectRawDoctorReport(config, process.env, Date.now);
  if (args[0] === "doctor" && args[1] === "fix") {
    // One check's fix as it is, for this person to run here; never shared or bundled.
    const id = args[2];
    if (!id || args.length > 3) throw new Error("Usage: ace doctor fix ID");
    const check = raw.checks.find((candidate) => candidate.id === id);
    if (!check) throw new Error(`ace doctor has no check ${id}`);
    write(check.status === "ok" ? `${id} passes; nothing to fix.\n` : `${check.fix}\n`);
    return true;
  }
  const report = redactDoctorReport(raw, process.env);
  if (args[0] === "doctor") {
    if (args.slice(1).some((arg) => arg !== "--json"))
      throw new Error("Usage: ace doctor [--json] | ace doctor fix ID");
    write(redact(args.includes("--json") ? JSON.stringify(report) : formatDoctor(report)) + "\n");
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
      threads: () => recentThreadEvents(join(config.dataDir, "events.sqlite"), context),
    });
  } catch (error) {
    if (created) await rm(path, { force: true });
    throw error;
  }
  write(`Support bundle: ${path}\n`);
  return true;
}
