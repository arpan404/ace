import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRedactor, createTextRedactor } from "@ace/redaction";
import { createFileSink, createLogger, logFields, logMetadata } from "@ace/diagnostics";
import { temporary, controlledWorker } from "./test-support.ts";

const secret = "OPAQUE_CLI_CREDENTIAL";
const payload = { credentials: { login: secret }, code: 7, inputTokens: 12 };
const diagnostics = [
  `request failed: ${JSON.stringify(payload)}`,
  `request failed: ${JSON.stringify(JSON.stringify(payload))}`,
  `request failed: {"credentials":{"login":"${secret}"`,
];

it("provider stderr credentials disappear before recent diagnostic evidence is returned", async () => {
  const logger = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 1,
    redact: createRedactor({}),
  });
  try {
    for (const stderr of diagnostics)
      logger.log("warn", "Provider exit", logFields([["evidence", logMetadata({ stderr })]]));
    const recent = logger.recent().join("\n");
    expect(recent).not.toContain(secret);
    expect(recent).toContain("request failed");
    expect(recent).toContain("INVALID STRUCTURED DATA OMITTED");
  } finally {
    await logger.close();
  }
});

it.each([false, true])(
  "file logging scrubs embedded credentials with worker=%s",
  async (worker) => {
    const directory = await temporary();
    const context = {
      home: "/private/home",
      workspace: "/private/home/repo",
      env: { CUSTOM: "opaque-env" },
    };
    const sink = await createFileSink(
      { directory, fileBytes: 65536, totalBytes: 131072, context },
      worker ? controlledWorker : undefined,
    );
    try {
      await sink.write(
        diagnostics.map((text) => ({
          at: 1,
          level: "warn",
          component: "provider",
          message: "Provider exit",
          data: {
            stderr: createTextRedactor(context)(text),
            path: "/private/home/repo/file",
            env: "opaque-env",
          },
        })),
      );
      const saved = await readFile(join(directory, "ace.jsonl"), "utf8");
      expect(saved).not.toContain(secret);
      expect(saved).not.toContain("opaque-env");
      expect(saved).not.toContain("/private/home");
      expect(saved).toContain("<WORKSPACE>/file");
      expect(saved).toContain("inputTokens");
      expect(saved).toContain("12");
      expect(saved).toContain("INVALID STRUCTURED DATA OMITTED");
      const rows: unknown[] = saved
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows[0]).toMatchObject({ data: { stderr: expect.stringContaining('"code":7') } });
    } finally {
      await sink.close();
    }
  },
);
