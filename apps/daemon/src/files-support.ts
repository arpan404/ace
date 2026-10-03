import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { writeSupportBundle } from "@ace/diagnostics";
import { createRedactor, type RedactionContext } from "@ace/redaction";

/** Reuse the diagnostics owner; remote exports never invoke provider/doctor probes. */
export function supportBundleWriter(
  dataDir: string,
  temporaryRoot: string,
  context: RedactionContext,
  now: () => number,
) {
  const redact = createRedactor(context);
  return async (temporary: string) => {
    await writeSupportBundle({
      logsDirectory: join(dataDir, "logs"),
      temporaryRoot,
      output: createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      report: { at: now(), checks: [] },
      versions: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        ace: "development",
      },
      settings: { threadsIncluded: false, providerProbesRun: false },
      redact,
      maxBytes: 16 * 1024 ** 2,
      maxInputBytes: 64 * 1024 ** 2,
    });
    const file = await open(temporary, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  };
}
