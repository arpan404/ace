import { expect, it } from "vitest";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";

const values = [
  'left{ "value": "OPAQUE_ENV_CREDENTIAL" }right',
  'left{ "value": "OPAQUE\\u005fENV_CREDENTIAL" }right',
];

it.each(values)(
  "configured JSON-fragment secrets stay private through normalization and escaping: %s",
  (value) => {
    const redact = createDiagnosticRedactor({ env: { CUSTOM: value } });
    for (const evidence of [
      `request failed: ${value}`,
      `request failed: ${JSON.stringify(value)}`,
    ]) {
      for (const input of [evidence, JSON.stringify({ stderr: evidence })]) {
        const safe = redact(input);
        expect(safe).not.toContain("OPAQUE");
        expect(safe).toContain("request failed");
        expect(safe).toContain("<ENV>");
      }
    }
  },
);

it("environment values matching JSON keys cannot hide credential containers", () => {
  const redact = createDiagnosticRedactor({ env: { CUSTOM: "credentials" } });
  for (const input of [
    'request failed: {"credentials":{"login":"OPAQUE_CONTAINER_CREDENTIAL"},"code":7}',
    JSON.stringify({
      stderr: 'request failed: {"credentials":{"login":"OPAQUE_CONTAINER_CREDENTIAL"},"code":7}',
    }),
  ]) {
    const safe = redact(input);
    expect(safe).not.toContain("OPAQUE_CONTAINER_CREDENTIAL");
    expect(safe).toContain("<SECRET>");
    expect(safe).toContain("code");
    expect(safe).toContain("7");
  }
});
