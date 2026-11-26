import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import { createFileSink, createLogger, logFields, logProviderKind } from "./index.ts";
import { TRUSTED_KEY } from "./trusted.ts";

/** One record through a real file sink, with `env` as its redaction context. */
async function logged(
  env: Record<string, string>,
  entries: readonly (readonly [string, unknown])[],
) {
  const directory = await mkdtemp(join(tmpdir(), "ace-trusted-"));
  const context = { env };
  const redact = createDiagnosticRedactor(context);
  const log = createLogger({
    sink: await createFileSink({ directory, fileBytes: 65536, totalBytes: 131072, context }),
    now: () => 1,
    redact,
    level: "warn",
  });
  try {
    log.log("warn", "Provider session opening failed", logFields(entries));
    await log.flush();
    return {
      written: await readFile(join(directory, "ace.jsonl"), "utf8"),
      recent: log.recent().join("\n"),
    };
  } finally {
    await log.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/*
 * A provider kind is ace's own closed enum, so it is structured data: a tool in the environment
 * that happens to use the same word (the opencode CLI exports AI_AGENT=opencode, and a secret's
 * value can spell it too) must not blank the field. Everything beside it stays redacted.
 */
it("a trusted provider kind survives an environment value that spells it while free text and secret keys scrub", async () => {
  const { written, recent } = await logged({ AI_AGENT: "opencode", CURSOR_API_KEY: "opencode" }, [
    ["provider", logProviderKind("opencode")],
    ["detail", "opencode refused the login"],
    ["credentials", "opencode"],
  ]);
  expect(JSON.parse(written)).toMatchObject({
    data: {
      provider: "opencode",
      detail: "<ENV> refused the login",
      credentials: "<SECRET>",
    },
  });
  expect(recent).toContain('"provider":"opencode"');
});

it("a value outside the provider kinds is logged as a normal, redacted string", async () => {
  const { written } = await logged({ CURSOR_API_KEY: "not-a-provider" }, [
    ["provider", logProviderKind("not-a-provider")],
  ]);
  expect(JSON.parse(written)).toMatchObject({ data: { provider: "<ENV>" } });
});

it("a field spelled like the trusted marker is renamed and its value redacted", async () => {
  const { written } = await logged({ CURSOR_API_KEY: "opencode" }, [
    ["provider", { [TRUSTED_KEY]: "opencode" }],
  ]);
  expect(JSON.parse(written)).toMatchObject({ data: { provider: { "<KEY>": "<ENV>" } } });
});
