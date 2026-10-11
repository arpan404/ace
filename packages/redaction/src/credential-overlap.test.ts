import { expect, it } from "vitest";
import { createRedactor, createStreamingRedactor, createTextRedactor } from "@ace/redaction";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";

it.each([
  ["password", "password=OPAQUE_BARE_CREDENTIAL"],
  ["Bearer", "Bearer OPAQUE_HEADER_CREDENTIAL"],
  ["Basic", "Basic OPAQUE_HEADER_CREDENTIAL"],
  ["sk-ant-", "sk-ant-OPAQUE_PROVIDER_CREDENTIAL"],
])("configured %s prefixes cannot expose the rest of a credential", (value, evidence) => {
  const context = { env: { CUSTOM: value } };
  for (const redact of [createTextRedactor(context), createRedactor(context), createDiagnosticRedactor(context)]) {
    for (const input of [evidence, JSON.stringify({ message: evidence })]) {
      const safe = redact(input);
      expect(safe).not.toContain("OPAQUE");
      expect(safe).toContain("<SECRET>");
    }
  }
  const prefix = "A".repeat(4089) + " ";
  const safe = [...createStreamingRedactor(context)(`${prefix}${evidence} after`)].join("");
  expect(safe).toBe(`${prefix}<SECRET> after`);
});

it("streaming masks a credential value when its identifying JSON key crosses a chunk boundary", () => {
  const input = "A".repeat(4084) + '{"password":"OPAQUE_JSON_CREDENTIAL"} after';
  const safe = [...createStreamingRedactor({})(input)].join("");
  expect(safe).not.toContain("OPAQUE_JSON_CREDENTIAL");
  expect(safe).toContain('"password":"<SECRET>"');
  expect(safe).toContain("after");
});
