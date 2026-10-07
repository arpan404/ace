import { expect, test } from "vitest";
import { createRedactor, createTextRedactor, createStreamingRedactor } from "@ace/redaction";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";

const key = "opaque-provider-key-with-no-recognizable-prefix";
test("API-key messages stay secret in structured, diagnostic, text and streamed redaction", () => {
  const message = {
    type: "provider.login.apiKey",
    requestId: "submit",
    session: "session",
    apiKey: key,
  };
  const json = JSON.stringify(message);
  for (const redact of [createRedactor({}), createTextRedactor({}), createDiagnosticRedactor({})]) {
    expect(redact(json)).not.toContain(key);
    expect(redact(json)).toContain("SECRET");
  }
  expect([...createStreamingRedactor({})(json)].join("")).not.toContain(key);
  expect(createRedactor({})(JSON.stringify({ nested: message, embedded: json }))).not.toContain(
    key,
  );
});
