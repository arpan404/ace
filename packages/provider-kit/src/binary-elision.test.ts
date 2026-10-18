import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { elidedDigest, elidedJson } from "./binary-elision.ts";
import { ProviderPayload } from "./payload.ts";

const screenshot = Buffer.alloc(3 * 1024 * 1024, 0);
for (let i = 0; i < screenshot.length; i++) screenshot[i] = (i * 31 + (i >> 9)) % 256;
const sha256 = createHash("sha256").update(screenshot).digest("hex");

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

test("a message with multi-megabyte screenshots records as a small payload naming each image's digest", () => {
  const message = {
    type: "user",
    message: {
      content: [
        { type: "text", text: "what is wrong here?" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: screenshot.toString("base64") },
        },
        { type: "image", url: `data:image/png;base64,${screenshot.toString("base64")}` },
      ],
    },
  };
  const payload = new ProviderPayload(elidedJson(message));
  expect(payload.bytes).toBeLessThan(4096);
  expect(payload.data).toMatchObject({
    message: { content: [{ type: "text", text: "what is wrong here?" }, { type: "image" }, {}] },
  });
  const digests = strings(payload.data).flatMap((value) => elidedDigest(value) ?? []);
  expect(digests).toEqual([sha256, sha256]);
  expect(JSON.stringify(payload.data)).toContain(`${screenshot.length} bytes of data:image/png`);
});

test("long prose, code and pasted text are recorded whole", () => {
  const prose = "The build fails when the cache is cold. ".repeat(2048);
  const code = `const values = [${Array.from({ length: 6000 }, (_, i) => i).join(",")}];`;
  const message = {
    content: [
      { type: "text", text: prose },
      { type: "text", text: code },
    ],
  };
  expect(JSON.parse(elidedJson(message))).toEqual(message);
});

test("short base64 such as ids and tokens is never elided", () => {
  const value = { id: Buffer.from("tool-call-identifier").toString("base64"), n: 1 };
  expect(elidedJson(value)).toBe(JSON.stringify(value));
  expect(elidedDigest(value.id)).toBeUndefined();
});
