import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import { createFileSink, createLogger, logFields, logTrusted } from "./index.ts";

/*
 * A provider kind is ace's own closed enum, so it is structured data: a tool in the environment
 * that happens to use the same word (the opencode CLI exports AI_AGENT=opencode, and a secret's
 * value can spell it too) must not blank the field. Everything beside it stays redacted.
 */
it("a trusted provider field survives an environment value that spells it while free text and secret keys scrub", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-trusted-"));
  const context = { env: { AI_AGENT: "opencode", CURSOR_API_KEY: "opencode" } };
  const redact = createDiagnosticRedactor(context);
  const log = createLogger({
    sink: await createFileSink({ directory, fileBytes: 65536, totalBytes: 131072, context }),
    now: () => 1,
    redact,
    level: "warn",
  });
  try {
    log.log(
      "warn",
      "Provider session opening failed",
      logFields([
        ["provider", logTrusted("opencode")],
        ["detail", "opencode refused the login"],
        ["credentials", "opencode"],
      ]),
    );
    await log.flush();
    const written = await readFile(join(directory, "ace.jsonl"), "utf8");
    expect(JSON.parse(written)).toMatchObject({
      data: {
        provider: "opencode",
        detail: "<ENV> refused the login",
        credentials: "<SECRET>",
      },
    });
    expect(log.recent().join("\n")).toContain('"provider":"opencode"');
  } finally {
    await log.close();
    await rm(directory, { recursive: true, force: true });
  }
});
