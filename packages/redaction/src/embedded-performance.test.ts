import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";

it("omitting a record with thousands of contained secret prefixes finishes within a bounded budget", () => {
  const redact = createDiagnosticRedactor({ env: { FIRST: "lead{", SECOND: "[xxx" } });
  // Each input stays below the public diagnostic size limit. Together these
  // exercise over 200k characters, rather than timing the oversized shortcut.
  const input = 'lead{"note":"' + "[xxx ".repeat(12000) + '"} after';
  const started = performance.now();
  for (let i = 0; i < 4; i++) expect(redact(input)).toBe("<ENV> after");
  expect(performance.now() - started).toBeLessThan(5000);
}, 10000);
