import { expect, it } from "vitest";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";

it("an unquoted backslash cannot hide a consumed credential-container opener", () => {
  const redact = createDiagnosticRedactor({ env: { CUSTOM: "lead\\{" } });
  const evidence = 'lead\\{"credentials":{"login":"OPAQUE_CONTAINER_CREDENTIAL"},"code":7}';
  for (const input of [evidence, JSON.stringify(evidence), JSON.stringify({ stderr: evidence })]) {
    const safe = redact(input);
    expect(safe).not.toContain("OPAQUE_CONTAINER_CREDENTIAL");
    expect(safe).toContain("<ENV>");
  }
});

it("quoted backslashes and braces do not consume unrelated diagnostic records", () => {
  const redact = createDiagnosticRedactor({ env: { CUSTOM: "lead\\{" } });
  const input = 'before "lead\\\\{ harmless" {"code":7} after';
  const safe = redact(input);
  expect(safe).toContain("<ENV> harmless");
  expect(safe).toContain('"code":7');
  expect(safe).toContain("after");
});
