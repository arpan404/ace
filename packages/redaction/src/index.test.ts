import { expect, it } from "vitest";
import { createRedactor } from "@ace/redaction";
const redact = createRedactor({ home: "/private/home" });
const payload = { refreshToken: ["OPAQUE_REFRESH"], password: { value: "OPAQUE_PASSWORD" } };
it("literal stream fragments keep JSON delimiters while secrets and structural payloads stay scrubbed", () => {
  const redactText = createRedactor({ env: { CURSOR_API_KEY: "sentinel-credential" } }, ["text"]);
  for (const text of ["{", "[", '"', '{"visible":', "sentinel-credential"]) {
    const result = JSON.parse(redactText(JSON.stringify({ text, payload })));
    expect(result.text).toBe(text === "sentinel-credential" ? "<ENV>" : text);
    expect(result.payload).toEqual({ refreshToken: "<SECRET>", password: "<SECRET>" });
  }
});
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

it("JSON-string wrappers cannot hide structural secrets and preserve ordinary encoded content", () => {
  const secret = "OPAQUE_WRAPPED_REFRESH";
  let wrapped = JSON.stringify({ refreshToken: [secret], values: [1, "visible"] });
  for (let depth = 0; depth < 3; depth++) {
    wrapped = JSON.stringify(wrapped);
    const clean = createRedactor({})(JSON.stringify({ payload: wrapped }));
    expect(clean).not.toContain(secret);
    let decoded: unknown = JSON.parse(clean).payload;
    for (let layer = 0; layer <= depth + 1; layer++) {
      if (typeof decoded !== "string") throw new Error("Expected encoded JSON string");
      decoded = JSON.parse(decoded);
    }
    expect(decoded).toEqual({ refreshToken: "<SECRET>", values: [1, "visible"] });
  }
});
