import { expect, test } from "vitest";
import { sanitize } from "./redaction.ts";

test("opaque provider state is redacted under both its 2.0 and 2.1 names, text is kept", () => {
  const event = {
    type: "session.text.ended",
    data: {
      text: "Pushed.",
      providerState: { reasoningEncryptedContent: "secret-20" },
      native: { itemId: "rs_1", reasoningEncryptedContent: "secret-21" },
    },
  };
  const clean = sanitize(event);
  expect(clean).toEqual({
    type: "session.text.ended",
    data: { text: "Pushed.", providerState: "[redacted]", native: "[redacted]" },
  });
});

test("fields that only contain the word native are not redacted", () => {
  expect(sanitize({ nativeSessionId: "ses_1", native_name: "shell" })).toEqual({
    nativeSessionId: "ses_1",
    native_name: "shell",
  });
});

test("credentials and session secrets are redacted deep inside evidence, and the rest is kept", () => {
  const evidence = {
    kept: { text: "plain", count: 2, flags: [true, null] },
    output: ["fine", "curl -H 'Authorization: Bearer abc.def-1'", { note: "token sk-live-1 used" }],
  };
  expect(sanitize(evidence, ["sk-live-1"])).toEqual({
    kept: { text: "plain", count: 2, flags: [true, null] },
    output: ["fine", "curl -H 'Authorization: [redacted]'", { note: "token [redacted] used" }],
  });
  expect(evidence.output[1]).toBe("curl -H 'Authorization: Bearer abc.def-1'");
});

test("evidence is bounded to 2,048 entries per list or object and 12 levels deep", () => {
  const wide = Array.from({ length: 2050 }, (_, index) => index);
  const fields = Object.fromEntries(wide.map((index) => [`k${index}`, index]));
  let deep: unknown = "bottom";
  for (let level = 0; level < 14; level++) deep = { deep };
  const clean = sanitize({ wide, fields, deep });
  expect(clean).toMatchObject({ wide: wide.slice(0, 2048) });
  const json = JSON.stringify(clean);
  expect(json.match(/"k\d+":/g)).toHaveLength(2048);
  expect(json).toContain('"[depth limit]"');
  expect(json).not.toContain("bottom");
});

test("objects that are not plain JSON keep only their own fields", () => {
  expect(sanitize({ when: new Date(0), map: new Map([["a", 1]]) })).toEqual({ when: {}, map: {} });
});
