import { describe, expect, it } from "vitest";
import {
  newWebhookSecret,
  readWebhookHeaders,
  signWebhook,
  verifyWebhook,
} from "./webhook-signature.ts";

// The example in the Standard Webhooks specification and its reference libraries.
const reference = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: "1614265330",
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};
const at = Number(reference.timestamp) * 1000;
const bytes = (text: string) => new TextEncoder().encode(text);
const headers = (overrides: Record<string, string> = {}) =>
  new Headers({
    "webhook-id": reference.id,
    "webhook-timestamp": reference.timestamp,
    "webhook-signature": reference.signature,
    ...overrides,
  });
const verify = (head: Headers, body = reference.body, now = at, secret = reference.secret) => {
  const read = readWebhookHeaders(head);
  if (!read.ok) return read.error;
  return verifyWebhook(secret, read.headers, bytes(body), now);
};

describe("webhook signatures", () => {
  it("signs the specification's example to its published signature", () => {
    expect(signWebhook(reference.secret, reference.id, 1614265330, bytes(reference.body))).toBe(
      reference.signature,
    );
  });

  it("accepts the specification's example request", () => {
    expect(verify(headers())).toBe("ok");
  });

  it("accepts a request when any one of several signatures matches", () => {
    expect(
      verify(headers({ "webhook-signature": `v1,bm90IGl0 v2,abc ${reference.signature}` })),
    ).toBe("ok");
  });

  it("refuses a body with one byte changed", () => {
    expect(verify(headers(), '{"test": 2432232315}')).toBe("bad_signature");
  });

  it("refuses a request signed with another secret", () => {
    expect(
      verify(
        headers(),
        reference.body,
        at,
        newWebhookSecret(() => new Uint8Array(32)),
      ),
    ).toBe("bad_signature");
  });

  it("refuses a signature replayed under another delivery id", () => {
    expect(verify(headers({ "webhook-id": "msg_other" }))).toBe("bad_signature");
  });

  it("refuses timestamps more than five minutes from now, either way", () => {
    expect(verify(headers(), reference.body, at + 5 * 60_000)).toBe("ok");
    expect(verify(headers(), reference.body, at + 5 * 60_000 + 1000)).toBe("stale_timestamp");
    expect(verify(headers(), reference.body, at - 5 * 60_000 - 1000)).toBe("stale_timestamp");
  });

  it("refuses missing or malformed headers", () => {
    const without = headers();
    without.delete("webhook-id");
    expect(verify(without)).toBe("bad_headers");
    expect(verify(headers({ "webhook-timestamp": "soon" }))).toBe("bad_headers");
    expect(verify(headers({ "webhook-id": "x".repeat(257) }))).toBe("bad_headers");
    expect(verify(headers({ "webhook-id": "has space" }))).toBe("bad_headers");
    expect(verify(headers({ "webhook-signature": "" }))).toBe("bad_headers");
  });

  it("makes secrets of 32 random bytes that verify their own signatures", () => {
    const secret = newWebhookSecret((size) => new Uint8Array(size).fill(7));
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const signature = signWebhook(secret, "d1", 1_700_000_000, bytes("{}"));
    const read = readWebhookHeaders(
      new Headers({
        "webhook-id": "d1",
        "webhook-timestamp": "1700000000",
        "webhook-signature": signature,
      }),
    );
    if (!read.ok) throw new Error(read.error);
    expect(verifyWebhook(secret, read.headers, bytes("{}"), 1_700_000_000_000)).toBe("ok");
  });
});
