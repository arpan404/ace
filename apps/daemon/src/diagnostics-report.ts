import { createDoctorChecks, createSystemProbes, runDoctor, type Check } from "@ace/diagnostics";
import { isSecretKey } from "@ace/redaction";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import { DiagnosticReport, type DiagnosticRepair } from "@ace/protocol";
import { homedir } from "node:os";
import { remoteDoctorChecks } from "./doctor.ts";
import type { Config } from "./config.ts";
import { localDoctorChecks, repairDoctor } from "./doctor-repairs.ts";

/** The CLI and authenticated app run the same bounded, read-only probes. */
export async function collectDoctorReport(
  config: Config,
  env: NodeJS.ProcessEnv,
  now: () => number,
  /** The CLI adds its doctor features' checks here; the app runs the base set. */
  extra: readonly Check[] = [],
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
      ...localDoctorChecks(config.dataDir, process.getuid?.()),
      ...extra,
    ],
    { now },
  );
  return DiagnosticReport.parse(
    JSON.parse(
      // Secret-looking variables only: redacting every value hid versions and paths too.
      createDiagnosticRedactor({ home: homedir(), env: secretEnvironment(env) })(
        JSON.stringify(report),
      ),
    ),
  );
}

export async function fixDoctorReport(
  config: Config,
  env: NodeJS.ProcessEnv,
  now: () => number,
  options: {
    assertAuthorized?: () => void;
    repairDatabase?: (report: DiagnosticReport) => Promise<DiagnosticRepair[]>;
  } = {},
) {
  const before = await collectDoctorReport(config, env, now);
  options.assertAuthorized?.();
  const repairs = await repairDoctor(config.dataDir, before, process.getuid?.());
  if (options.repairDatabase) repairs.push(...(await options.repairDatabase(before)));
  return { report: await collectDoctorReport(config, env, now), repairs };
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

function secretEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => isSecretKey(key)));
}
