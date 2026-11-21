import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { WEBHOOK_MAX_BYTES } from "./workos-webhook.ts";
import { workosWebhookRoute } from "./workos-webhook-route.ts";
import type { WorkosEvent } from "./workos-orgs.ts";

/*
 * What the webhook route takes as WorkOS's (ADR 0206 §6, amendment 1): one canonical
 * timestamp and well-formed signatures, over the very bytes WorkOS sent, read no further than
 * the route's limit.
 */

const SECRET = "whsec_unit_test_secret_value";
const NOW = 1_800_000_000_000;
const event = {
  id: "event_01UNIT",
  event: "organization_membership.updated",
  data: { id: "om_1" },
  created_at: "2027-01-15T08:00:00.000Z",
};
const json = JSON.stringify(event);
const mac = (bytes: Uint8Array | string, at = NOW) =>
  createHmac("sha256", SECRET)
    .update(Buffer.concat([Buffer.from(`${at}.`), Buffer.from(bytes)]))
    .digest("hex");

function route() {
  const delivered: WorkosEvent[] = [];
  const handle = workosWebhookRoute({
    secret: SECRET,
    events: {
      deliver: async (each) => {
        delivered.push(each);
      },
      catchUp: async () => ({ applied: 0, pages: 0 }),
    },
    now: () => NOW,
  });
  return { handle, delivered };
}
const post = (body: BodyInit, header: string, headers: Record<string, string> = {}) =>
  new Request("https://cloud.example/v1/workos/webhook", {
    method: "POST",
    headers: { "WorkOS-Signature": header, ...headers },
    body,
    duplex: "half",
  } as RequestInit);

it("takes a delivery signed over its body with one timestamp", async () => {
  const { handle, delivered } = route();
  expect((await handle(post(json, `t=${NOW}, v1=${mac(json)}`))).status).toBe(200);
  expect(delivered.map((each) => each.id)).toEqual([event.id]);
});

it("refuses a signature header with a repeated timestamp, a stray '=' or a malformed field", async () => {
  const { handle, delivered } = route();
  const good = mac(json);
  for (const header of [
    // Two timestamps: which one was signed is ambiguous, whichever is last.
    `t=${NOW - 999_999}, t=${NOW}, v1=${good}`,
    `t=${NOW}=1, v1=${good}`,
    `t=${NOW}, v1=${good}=x`,
    `t=${NOW}, v1=${good}, v0`,
    `t=${NOW}, v1=${good}, =`,
    `t=0${NOW}, v1=${good}`,
  ])
    expect((await handle(post(json, header))).status, header).toBe(401);
  expect(delivered).toEqual([]);
});

it("checks the signature over the bytes WorkOS sent, a byte-order mark included", async () => {
  const { handle, delivered } = route();
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(json)]);
  // Signed over the text without its mark, the body as sent isn't what was signed.
  expect((await handle(post(bytes, `t=${NOW}, v1=${mac(json)}`))).status).toBe(401);
  expect(delivered).toEqual([]);
  // Signed over the bytes as sent, it is, and the mark doesn't stop the event being read.
  expect((await handle(post(bytes, `t=${NOW}, v1=${mac(bytes)}`))).status).toBe(200);
  expect(delivered.map((each) => each.id)).toEqual([event.id]);
});

it("stops reading a body past the limit without waiting for its end", async () => {
  const { handle } = route();
  // No Content-Length, more than the limit, and a stream that never ends.
  const endless = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(WEBHOOK_MAX_BYTES + 1));
    },
  });
  const answer = await Promise.race([
    handle(post(endless, `t=${NOW}, v1=${"0".repeat(64)}`)),
    new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 2_000)),
  ]);
  expect(answer === "waited" ? answer : answer.status).toBe(413);
});
