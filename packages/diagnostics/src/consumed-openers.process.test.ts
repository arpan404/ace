import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import { createFileSink, createLogger, logFields } from "@ace/diagnostics";
import { controlledWorker, temporary } from "./test-support.ts";

it.each([false, true])(
  "a backslash before a consumed opener cannot leak stderr into recent or saved output with worker=%s",
  async (worker) => {
    const directory = await temporary();
    const context = { env: { CUSTOM: "lead\\{" } };
    const log = createLogger({
      sink: await createFileSink(
        { directory, fileBytes: 65536, totalBytes: 131072, context },
        worker ? controlledWorker : undefined,
      ),
      now: () => 1,
      redact: createDiagnosticRedactor(context),
    });
    try {
      log.log(
        "warn",
        "Provider diagnostic",
        logFields([
          ["stderr", 'lead\\{"credentials":{"login":"OPAQUE_CONTAINER_CREDENTIAL"},"code":7}'],
        ]),
      );
      await log.flush();
      const saved = await readFile(join(directory, "ace.jsonl"), "utf8");
      expect(log.recent()).toHaveLength(1);
      for (const bytes of [saved, ...log.recent()]) {
        expect(bytes).not.toContain("OPAQUE_CONTAINER_CREDENTIAL");
        expect(bytes).toContain("Provider diagnostic");
        expect(bytes).toContain("<ENV>");
      }
    } finally {
      await log.close();
    }
  },
);
