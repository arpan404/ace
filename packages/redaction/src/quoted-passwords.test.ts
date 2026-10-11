import { expect, it } from "vitest";
import { createRedactor, createStreamingRedactor, createTextRedactor } from "@ace/redaction";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";

it.each([
  'password="first private, second; private \\"quote\\" tail"',
  "token='first private, second; private \\'quote\\' tail'",
  'password="unclosed private, suffix; tail',
])("quoted credentials are removed in full across every public redaction API: %s", (assignment) => {
  const text = `before ${assignment}`;
  expect(createTextRedactor({})(text)).toBe("before <SECRET>");
  expect([...createStreamingRedactor({})(text)].join("")).toBe("before <SECRET>");
  expect(JSON.parse(createRedactor({})(JSON.stringify({ message: text })))).toEqual({
    message: "before <SECRET>",
  });
  expect(createDiagnosticRedactor({})(text)).toBe("before <SECRET>");
});

it("a quoted credential crossing stream chunk boundaries preserves surrounding text", () => {
  const prefix = "visible ".repeat(510);
  const secret = "private, suffix; ".repeat(300);
  const text = `${prefix}password="${secret}" after`;
  expect([...createStreamingRedactor({})(text)].join("")).toBe(`${prefix}<SECRET> after`);
});
