import { expect, it } from "vitest";
import { createRedactor } from "@ace/redaction";
const redact = createRedactor({ home: "/private/home" });
const payload = { refreshToken: ["OPAQUE_REFRESH"], password: { value: "OPAQUE_PASSWORD" } };
it.each([
  ["embedded payload", JSON.stringify({ payload: JSON.stringify(payload) })],
  ["colliding keys", JSON.stringify({ "/private/home": 1, "<HOME>": 2, ...payload })],
  ["deep JSON", "[".repeat(10000) + JSON.stringify(payload) + "]".repeat(10000)],
  ["damaged JSON", '{"refreshToken":["OPAQUE_REFRESH"]'],
])("%s cannot expose array or object secrets through fallback redaction", (_name, line) => {
  const clean = redact(line);
  expect(clean).not.toContain("OPAQUE_REFRESH");
  expect(clean).not.toContain("OPAQUE_PASSWORD");
  expect(() => JSON.parse(clean)).not.toThrow();
});
it("mixed-case authorization is removed while ordinary arrays and permitted recorder email survive", () => {
  const result = JSON.parse(
    redact(
      JSON.stringify({
        message: "bEaReR OPAQUE_ACCESS",
        values: [1, true, "visible"],
        email: "recorder@ace.invalid",
        privateEmail: "person@example.com",
      }),
    ),
  );
  expect(result.message).toBe("<SECRET>");
  expect(result.values).toEqual([1, true, "visible"]);
  expect(result.email).toBe("recorder@ace.invalid");
  expect(result.privateEmail).toBe("<EMAIL>");
});
