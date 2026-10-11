import { expect, it } from "vitest";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import { createRedactor, createStreamingRedactor, createTextRedactor } from "@ace/redaction";

it("overlapping configured secrets mask their complete union in raw and escaped output", () => {
  const context = { env: { FIRST: "left{", SECOND: '{ "value": "OPAQUE_ENV_CREDENTIAL" }right' } };
  const value = 'left{ "value": "OPAQUE_ENV_CREDENTIAL" }right';
  for (const spelling of [value, JSON.stringify(value).slice(1, -1)]) {
    expect(createTextRedactor(context)(spelling)).toBe("<ENV>");
    expect(createDiagnosticRedactor(context)(spelling)).toBe("<ENV>");
    const general = createRedactor(context)(spelling);
    expect(general).not.toContain("OPAQUE");
    expect(general).toContain("<ENV>");
    const prefix = "A".repeat(4090);
    expect([...createStreamingRedactor(context)(`${prefix}${spelling} after`)].join("")).toBe(
      `${prefix}<ENV> after`,
    );
  }
});

it("a configured prefix consuming a credential-container opener cannot expose its contents", () => {
  const context = { env: { CUSTOM: 'lead{"credentials":' } };
  for (const evidence of [
    'lead{"credentials":{"login":"OPAQUE_CONTAINER_CREDENTIAL"},"code":7}',
    'lead{"credentials":{"login":"OPAQUE_CONTAINER_CREDENTIAL"}',
    'lead{"credentials":[{"login":"OPAQUE_CONTAINER_CREDENTIAL"}],"code":7}',
  ]) {
    for (const input of [evidence, JSON.stringify({ stderr: evidence })]) {
      expect(createDiagnosticRedactor(context)(input)).not.toContain("OPAQUE_CONTAINER_CREDENTIAL");
      expect(createDiagnosticRedactor(context)(input)).toContain("<ENV>");
    }
  }
});

it("repeated overlapping configured prefixes keep the trailing credential private", () => {
  const context = { env: { FIRST: "A".repeat(129), SECOND: "A".repeat(128) + "B" } };
  expect(createTextRedactor(context)("A".repeat(5000) + "B after")).toBe("<ENV> after");
});

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

it("configured objects nested inside larger JSON records are masked before whitespace normalization", () => {
  const value = '{ "value": "OPAQUE_ENV_CREDENTIAL" }';
  const redact = createDiagnosticRedactor({ env: { CUSTOM: value, KEY: "credentials" } });
  const evidence = `request failed: {"payload": ${value},"credentials":{"login":"OPAQUE_OTHER_CREDENTIAL"},"code":7}`;
  for (const input of [evidence, JSON.stringify({ stderr: evidence })]) {
    const safe = redact(input);
    expect(safe).not.toContain("OPAQUE");
    expect(safe).toContain("request failed");
    expect(safe).toContain("<ENV>");
    expect(safe).toContain("<SECRET>");
    expect(safe).toContain("code");
    expect(safe).toContain("7");
  }
});

it("configured values crossing an embedded record boundary are removed in full", () => {
  const value = '"OPAQUE_CROSS_CREDENTIAL"} tail';
  const safe = createDiagnosticRedactor({ env: { CUSTOM: value } })(
    `request failed: {"payload":${value}`,
  );
  expect(safe).not.toContain("OPAQUE");
  expect(safe).toContain("request failed");
  expect(safe).toContain("<ENV>");
});

it("JSON escape decoding cannot change a configured secret into visible credential text", () => {
  const value = "OPAQUE\\u005fENV_CREDENTIAL";
  const safe = createDiagnosticRedactor({ env: { CUSTOM: value } })(
    `request failed: {"payload":"${value}","code":7}`,
  );
  expect(safe).not.toContain("OPAQUE");
  expect(safe).toContain("<ENV>");
  expect(safe).toContain('"code":7');
});
