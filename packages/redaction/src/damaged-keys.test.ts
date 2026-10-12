import { expect, it } from "vitest";
import { createTextRedactor, createStreamingRedactor } from "@ace/redaction";

it.each([
  String.raw`before "token\q\"note":"OPAQUE_CREDENTIAL" after`,
  String.raw`before "token\x\"note":"OPAQUE_CREDENTIAL" after`,
  String.raw`before "token\uZZZZ\"note":"OPAQUE_CREDENTIAL" after`,
  String.raw`before "label\q\"note":"OPAQUE_CREDENTIAL" after`,
])("an ordinary suffix cannot dismiss a damaged key candidate: %s", (input) => {
  const expected = input.replace("OPAQUE_CREDENTIAL", "<SECRET>");
  expect(createTextRedactor({})(input)).toBe(expected);
  expect([...createStreamingRedactor({})(input)].join("")).toBe(expected);
  const prefix = "A".repeat(4096 - input.indexOf("\\") - 1);
  expect(createTextRedactor({})(prefix + input)).toBe(prefix + expected);
  expect([...createStreamingRedactor({})(prefix + input)].join("")).toBe(prefix + expected);
});

it("valid ordinary key candidates retain their value despite an escaped quote", () => {
  const input = String.raw`before "label\"note":"ordinary" after`;
  expect(createTextRedactor({})(input)).toBe(input);
  expect([...createStreamingRedactor({})(input)].join("")).toBe(input);
});

it("a damaged key cannot use an ordinary numeric suffix to bypass redaction", () => {
  const input = String.raw`before "token\q\"inputTokens":12 after`;
  expect(createTextRedactor({})(input)).toBe(
    String.raw`before "token\q\"inputTokens":"<SECRET>" after`,
  );
  expect([...createStreamingRedactor({})(input)].join("")).not.toContain("12");
});
