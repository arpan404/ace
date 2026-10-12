import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createTextRedactor, createStreamingRedactor } from "@ace/redaction";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";

const cases = [
  'before " {":token":"OPAQUE_CREDENTIAL"} after',
  String.raw`before \" {":token\"":"OPAQUE_CREDENTIAL"} after`,
  'before "note": " {"token":"OPAQUE_CREDENTIAL"} after',
  String.raw`before "note": " {"api\u005fkey":"OPAQUE_CREDENTIAL"} after`,
  String.raw`before \"token":"OPAQUE_CREDENTIAL" after`,
  String.raw`before "token\": "OPAQUE_CREDENTIAL" after`,
];

it.each(cases)("ambiguous prose cannot hide a sensitive assignment: %s", (input) => {
  for (const evidence of [input, JSON.stringify(input).slice(1, -1)]) {
    const expected = evidence.replace("OPAQUE_CREDENTIAL", "<SECRET>");
    expect(createTextRedactor({})(evidence)).toBe(expected);
    expect([...createStreamingRedactor({})(evidence)].join("")).toBe(expected);
    for (const diagnostic of [evidence, JSON.stringify({ stderr: evidence })])
      expect(createDiagnosticRedactor({})(diagnostic)).not.toContain("OPAQUE_CREDENTIAL");
    const prefix = "A".repeat(4080) + " ";
    expect([...createStreamingRedactor({})(prefix + evidence)].join("")).toBe(prefix + expected);
  }
});

it.each([
  String.raw`before \"token":"OPAQUE_CREDENTIAL" after`,
  String.raw`before "token\": "OPAQUE_CREDENTIAL" after`,
])("mixed key delimiters stay scrubbed when a streaming boundary splits the key: %s", (input) => {
  const prefix = "A".repeat(4096 - input.indexOf("token") - 2);
  const expected = prefix + input.replace("OPAQUE_CREDENTIAL", "<SECRET>");
  expect([...createStreamingRedactor({})(prefix + input)].join("")).toBe(expected);
  expect(createTextRedactor({})(prefix + input)).toBe(expected);
  expect(createDiagnosticRedactor({})(prefix + input)).not.toContain("OPAQUE_CREDENTIAL");
});

it.each([
  String.raw`before \"note":"ordinary" after`,
  String.raw`before "note\": "ordinary" after`,
])("mixed prose delimiters preserve an ordinary value: %s", (input) => {
  expect(createTextRedactor({})(input)).toBe(input);
  expect([...createStreamingRedactor({})(input)].join("")).toBe(input);
});

it.each(['" '.repeat(200000), '"note": " {"token":"private"} '.repeat(40000)])(
  "repeated quotes and assignments complete within a bounded streaming budget",
  (prefix) => {
    const input = prefix + ' {"token":"OPAQUE_CREDENTIAL"}';
    const started = performance.now();
    const safe = [...createStreamingRedactor({})(input)].join("");
    expect(safe).not.toContain("OPAQUE_CREDENTIAL");
    expect(safe).toContain("<SECRET>");
    if (prefix.includes("private")) expect(safe).not.toContain("private");
    expect(performance.now() - started).toBeLessThan(5000);
  },
  10000,
);

it("bare scalar credential values are masked while numeric usage counters survive", () => {
  const safe = createTextRedactor({})(
    '{"inputTokens":12,"password":OPAQUE_CREDENTIAL,"visible":7}',
  );
  expect(safe).not.toContain("OPAQUE_CREDENTIAL");
  expect(safe).toContain('"inputTokens":12');
  expect(safe).toContain('"visible":7');
});

it("an oversized key cannot hide a credential outside the bounded key window", () => {
  const input = '{"token' + "x".repeat(8000) + '":"OPAQUE_CREDENTIAL"}';
  expect(createTextRedactor({})(input)).not.toContain("OPAQUE_CREDENTIAL");
  expect([...createStreamingRedactor({})(input)].join("")).not.toContain("OPAQUE_CREDENTIAL");
});
