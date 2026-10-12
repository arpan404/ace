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

it.each(["Authorization", "OPAQUE_HEADER"])(
  "environment match %s cannot shorten a quoted credential",
  (value) => {
    const context = { env: { CUSTOM: value } };
    const text = 'before Authorization: "OPAQUE_HEADER_CREDENTIAL" after';
    expect(createTextRedactor(context)(text)).toBe("before <SECRET> after");
    expect(createDiagnosticRedactor(context)(text)).toBe("before <SECRET> after");
    expect(JSON.parse(createRedactor(context)(JSON.stringify({ message: text })))).toEqual({
      message: "before <SECRET> after",
    });
    expect([...createStreamingRedactor(context)(text)].join("")).toBe("before <SECRET> after");
  },
);

it("escaped configured secrets crossing a streaming boundary remain private", () => {
  const value = 'left{ "value": "OPAQUE_ENV_CREDENTIAL" }right';
  const prefix = "A".repeat(4090);
  const text = prefix + JSON.stringify(value).slice(1, -1) + " after";
  expect([...createStreamingRedactor({ env: { CUSTOM: value } })(text)].join("")).toBe(
    `${prefix}<ENV> after`,
  );
});
