import { expect, it } from "vitest";
import { leaseRedaction, redactLease, redactedFrameJson } from "./frame-redaction.ts";

const secret = "lease-0123456789abcdef";
function nested(depth: number, leaf: unknown): unknown {
  let value = leaf;
  for (let i = 0; i < depth; i++) value = { level: i, keep: "unrelated", child: value };
  return value;
}

it("a frame nested past any depth keeps its unrelated values and loses only the secret", () => {
  const frame = nested(200, { token: `Bearer ${secret}`, name: "deep" });
  const redacted = redactLease(frame, [secret]);
  expect(redacted).toEqual(nested(200, { token: `Bearer ${leaseRedaction}`, name: "deep" }));
  expect(JSON.stringify(redacted)).not.toContain("[depth limit]");
});

it("a secret used as a key is redacted without overwriting a field already named that", () => {
  const redacted = redactLease({ [secret]: 1, [leaseRedaction]: 2, other: [secret, "x"] }, [
    secret,
  ]);
  expect(redacted).toEqual({
    [leaseRedaction]: 2,
    [`${leaseRedaction}#1`]: 1,
    other: [leaseRedaction, "x"],
  });
});

it("a frame without a secret is published as serialized, uncopied", () => {
  const frame = { method: "session/update", params: { update: { text: "hello" } } };
  const published = redactedFrameJson(frame, [secret]);
  expect(published.json).toBe(JSON.stringify(frame));
  expect(published.value).toBe(frame);
});

it("a frame holding a secret, even one JSON escapes, is published redacted", () => {
  const quoted = 'lease"with\\quote';
  for (const key of [secret, quoted]) {
    const value = `token ${key}`;
    const published = redactedFrameJson({ params: { value } }, [key]);
    expect(JSON.parse(published.json)).toEqual({ params: { value: `token ${leaseRedaction}` } });
  }
});
