import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRedactor } from "@ace/redaction";
import { createFileSink, createLogger, logFields } from "./index.ts";
import { temporary } from "./test-support.ts";

const context = { home: "/Users/someone", env: { CUSTOM: "custom-environment-secret" } };
const redact = createRedactor(context);

async function persisted(write: (logger: ReturnType<typeof createLogger>) => void) {
  const directory = await temporary();
  const sink = await createFileSink({ directory, fileBytes: 65536, totalBytes: 131072, context });
  const logger = createLogger({ sink, now: () => 1, redact });
  write(logger);
  await logger.close();
  const text = await readFile(join(directory, "ace.jsonl"), "utf8");
  return {
    text,
    records: text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  };
}

it("a WebSocket heartbeat loss is logged with its code, reason, duration and client", async () => {
  const { records } = await persisted((logger) =>
    logger.log("warn", "WebSocket closed", {
      code: 4008,
      reason: "Idle timeout",
      durationMs: 61_250,
      authenticated: true,
      client: "ios",
    }),
  );
  expect(records[0].data).toEqual({
    code: 4008,
    reason: "Idle timeout",
    durationMs: 61_250,
    authenticated: true,
    client: "ios",
  });
});

it("a secret in a close reason, a home path and an environment value stay redacted", async () => {
  const { text, records } = await persisted((logger) =>
    logger.log("warn", "WebSocket closed", {
      code: 4001,
      reason: "Bearer abcdefghijklmnopqrstuvwxyz custom-environment-secret",
      path: "/Users/someone/project",
      token: "plain-token-value",
    }),
  );
  expect(records[0].data.code).toBe(4001);
  expect(records[0].data.token).toBe("<SECRET>");
  for (const secret of ["abcdefghijklmnopqrstuvwxyz", "custom-environment-secret", "someone"])
    expect(text).not.toContain(secret);
  expect(text).not.toContain("plain-token-value");
});

it("a record logged without data has no placeholder in place of its data", async () => {
  const { records } = await persisted((logger) => logger.log("error", "Shutdown deadline"));
  expect(records[0]).not.toHaveProperty("data");
});

it("an error keeps its class name and stack frames, with the home directory redacted", async () => {
  class StoreClosedError extends Error {}
  StoreClosedError.prototype.name = "StoreClosedError";
  const error = new StoreClosedError("database is not open");
  error.stack = [
    "StoreClosedError: database is not open",
    "custom-environment-secret on a message line",
    "    at Store.statement (file:///Users/someone/ace/store.ts:347:27)",
    "    at Store.listThreads (file:///Users/someone/ace/store.ts:882:17)",
  ].join("\n");
  const { text, records } = await persisted((logger) =>
    logger.log("error", "Store failure", logFields([["error", error]])),
  );
  expect(records[0].data.error).toMatchObject({
    message: "database is not open",
    name: "StoreClosedError",
    stack: [
      expect.stringMatching(/^at Store\.statement \(.*store\.ts:347:27\)$/),
      expect.stringMatching(/^at Store\.listThreads \(.*store\.ts:882:17\)$/),
    ],
  });
  expect(text).not.toContain("/Users/someone");
  expect(text).not.toContain("custom-environment-secret");
});

it("an error-shaped record with a message is still summarized, never enumerated", async () => {
  const { text, records } = await persisted((logger) =>
    logger.log("warn", "Failure", { message: "visible", code: "EIO", stderr: "private-stderr" }),
  );
  expect(records[0].data).toEqual({ message: "visible", code: "EIO" });
  expect(text).not.toContain("private-stderr");
});
