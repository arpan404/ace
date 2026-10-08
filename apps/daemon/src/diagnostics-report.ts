import { createDoctorChecks, createSystemProbes, runDoctor } from "@ace/diagnostics";
import { createRedactor } from "@ace/redaction";
import { DiagnosticReport } from "@ace/protocol";
import { homedir } from "node:os";
import { remoteDoctorChecks } from "./doctor.ts";
import type { Config } from "./config.ts";

/** The CLI and authenticated app run the same bounded, read-only probes. */
export async function collectDoctorReport(
  config: Config,
  env: NodeJS.ProcessEnv,
  now: () => number,
) {
  const report = await runDoctor(
    [
      ...createDoctorChecks(
        createSystemProbes({
          moduleOrigin: new URL("./index.ts", import.meta.url),
          dataDir: config.dataDir,
          port: config.port,
          env,
        }),
      ),
      ...remoteDoctorChecks(config, env),
    ],
    { now },
  );
  return DiagnosticReport.parse(
    JSON.parse(createRedactor({ home: homedir(), env })(JSON.stringify(report))),
  );
}

export async function connectedDoctorReport(
  config: Config,
  env: NodeJS.ProcessEnv,
  now: () => number,
) {
  const report = await collectDoctorReport(config, env, now);
  // The running listener owns this port. Checking whether another listener can bind it
  // is useful offline, but would be a false warning from the connected app.
  return { ...report, checks: report.checks.filter((check) => check.id !== "port") };
}
