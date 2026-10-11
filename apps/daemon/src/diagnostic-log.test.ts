import { expect, test } from "vitest";
import { logFields } from "@ace/diagnostics";
import { createDaemonLogger } from "./diagnostic-log.ts";

test("daemon recent output protects nested configured objects and contextual provider metadata", async () => {
  const object = '{ "value": "OPAQUE_ENV_CREDENTIAL" }';
  const value = `left${object}right`;
  const log = createDaemonLogger(
    { sink: { async write() {}, async close() {} }, now: () => 1 },
    { env: { OBJECT: object, CUSTOM: value, KEY: "credentials" } },
  );
  try {
    log.log(
      "warn",
      "Provider diagnostic",
      logFields([["raw", [log.metadata({ type: "stderr", text: `request failed: ${value}` })]]]),
    );
    log.log(
      "warn",
      "Provider diagnostic",
      logFields([
        [
          "stderr",
          `request failed: {"payload": ${object},"credentials":{"login":"OPAQUE_OTHER_CREDENTIAL"},"code":7}`,
        ],
      ]),
    );
    const recent = log.recent().join("\n");
    expect(recent).not.toContain("OPAQUE");
    expect(recent).toContain("request failed");
    expect(recent).toContain("<ENV>");
    expect(recent).toContain("<SECRET>");
    expect(recent).toContain("code");
    expect(recent).toContain("7");
  } finally {
    await log.close();
  }
});

test("daemon recent output retains the complete credential mask when an environment value names its header", async () => {
  const log = createDaemonLogger(
    { sink: { async write() {}, async close() {} }, now: () => 1 },
    { env: { CUSTOM: "Authorization" } },
  );
  try {
    log.log(
      "warn",
      'Authorization: "OPAQUE_HEADER_CREDENTIAL"',
      logFields([["stderr", 'Authorization: "OPAQUE_HEADER_CREDENTIAL"']]),
    );
    const recent = log.recent().join("\n");
    expect(recent).not.toContain("OPAQUE_HEADER_CREDENTIAL");
    expect(recent).toContain("<SECRET>");
  } finally {
    await log.close();
  }
});

test("daemon recent output scrubs raw credential containers and configured JSON-fragment secrets", async () => {
  const value = 'left{ "value": "OPAQUE_ENV_CREDENTIAL" }right';
  const escaped = 'left{ "value": "OPAQUE\\u005fENV_CREDENTIAL" }right';
  const log = createDaemonLogger(
    {
      sink: { async write() {}, async close() {} },
      now: () => 1,
    },
    { env: { CUSTOM: value, ESCAPED: escaped } },
  );
  try {
    // Direct messages and data deliberately bypass logMetadata and errorSummary.
    for (const evidence of [value, escaped, JSON.stringify(value), JSON.stringify(escaped)])
      log.log(
        "warn",
        `request failed: ${evidence}`,
        logFields([["stderr", `request failed: ${evidence}`]]),
      );
    log.log(
      "warn",
      "Provider exit",
      logFields([
        ["stderr", 'request failed: {"credentials":{"login":"OPAQUE_CLI_CREDENTIAL"},"code":7}'],
      ]),
    );
    const recent = log.recent().join("\n");
    expect(recent).not.toContain("OPAQUE");
    expect(recent).toContain("request failed");
    expect(recent).toContain("<ENV>");
    expect(recent).toContain("<SECRET>");
    expect(recent).toContain("code");
    expect(recent).toContain("7");
  } finally {
    await log.close();
  }
});
