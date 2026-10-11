import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createStreamingRedactor, createTextRedactor } from "@ace/redaction";

it.each([
  'before {"prefix_token_suffix":"OPAQUE_CREDENTIAL","visible":"ok"} after',
  'before {"api\\u005fkey" : "OPAQUE_CREDENTIAL","visible":"ok"} after',
  'before {"authorization":"OPAQUE_CREDENTIAL \\"private quote\\" tail","visible":"ok"} after',
])("JSON credential strings are removed without losing ordinary fields: %s", (input) => {
  for (const safe of [
    createTextRedactor({})(input),
    [...createStreamingRedactor({})(input)].join(""),
  ]) {
    expect(safe).not.toContain("OPAQUE_CREDENTIAL");
    expect(safe).not.toContain("private quote");
    expect(safe).toContain('"<SECRET>"');
    expect(safe).toContain('"visible":"ok"');
    expect(safe).toContain("before");
    expect(safe).toContain("after");
  }
});

it("ordinary JSON string values are not treated as credential keys", () => {
  const input = '{"note":"token secret authorization", "visible":"ok"}';
  expect(createTextRedactor({})(input)).toBe(input);
  expect([...createStreamingRedactor({})(input)].join("")).toBe(input);
});

it("a long credential key still masks its value across streaming chunks", () => {
  const input = '{"' + "token ".repeat(8000) + '":"OPAQUE_CREDENTIAL"}';
  for (const safe of [
    createTextRedactor({})(input),
    [...createStreamingRedactor({})(input)].join(""),
  ]) {
    expect(safe).not.toContain("OPAQUE_CREDENTIAL");
    expect(safe).toBe('{"' + "token ".repeat(8000) + '":"<SECRET>"}');
  }
});

it("streaming a key with 200k repeated credential words finishes within a bounded budget", () => {
  const input = '{"' + "token ".repeat(200000) + '":""}';
  const redact = createStreamingRedactor({});
  const started = performance.now();
  expect([...redact(input)].join("")).toBe(input);
  expect(performance.now() - started).toBeLessThan(5000);
}, 10000);
