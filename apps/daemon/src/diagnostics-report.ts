import {
  createDoctorChecks,
  createSystemProbes,
  linuxHost,
  linuxHostChecks,
  runDoctor,
  type Check,
} from "@ace/diagnostics";
import { checkBrowserEngine } from "@ace/browser/engine-check";
import { isSecretKey } from "@ace/redaction";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import { DiagnosticReport, type DiagnosticRepair } from "@ace/protocol";
import { homedir } from "node:os";
import { cursorSandboxChecks } from "./cursor-sandbox-check.ts";
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
): Promise<DiagnosticReport> {
  const report = await runDoctor(
    [
      ...createDoctorChecks(
        createSystemProbes({
          moduleOrigin: new URL("./index.ts", import.meta.url),
          dataDir: config.dataDir,
          port: config.port,
          env,
          browserEngine: (signal) => checkBrowserEngine({ dataDir: config.dataDir, env, signal }),
        }),
      ),
      ...(process.platform === "linux" ? linuxHostChecks(linuxHost(env, process.arch)) : []),
      ...(process.platform === "linux"
        ? cursorSandboxChecks({ dataDir: config.dataDir, home: homedir() })
        : []),
      ...remoteDoctorChecks(config, env),
      ...localDoctorChecks(config.dataDir, process.getuid?.()),
      ...extra,
    ],
    { now },
  );
  return redactDoctorReport(report, env);
}

/**
 * The report as the app, the CLI and support bundles show it. Only secret-looking variables
 * are redacted, so versions, paths and desktop session words (`user`, `wayland`, `GNOME`)
 * stay readable. Check ids are ace's own and stay as written. Fixes never carry commands with
 * this machine's paths: those are repairs, shown exactly by `ace doctor --dry-run`.
 */
export function redactDoctorReport(
  raw: DiagnosticReport,
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): DiagnosticReport {
  const redacted = DiagnosticReport.parse(
    JSON.parse(
      createDiagnosticRedactor({ home, env: secretEnvironment(env) })(JSON.stringify(raw)),
    ),
  );
  // The parsed copy is this function's own, so its ids are restored in place.
  for (const [index, check] of redacted.checks.entries()) {
    const original = raw.checks[index];
    if (original) check.id = original.id;
  }
  return redacted;
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
