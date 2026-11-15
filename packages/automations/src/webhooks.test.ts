import { describe, expect, it } from "vitest";
import { AutomationWebhooks, signWebhook, type WebhookRequest } from "./index.ts";
import { definition, harness, start } from "./service-test-support.ts";

let counter = 0;
function setup() {
  const h = harness();
  h.now = start;
  const bytes = (size: number) => new Uint8Array(size).map(() => ++counter % 256);
  const webhooks = () =>
    new AutomationWebhooks(h.store, h.service, { now: () => start, randomBytes: bytes });
  h.service.put(
    definition({
      id: "deploy",
      trigger: { kind: "webhook" },
      prompt: "Check the {{body.env}} deploy of {{body.commit}}",
    }),
  );
  return { h, webhooks };
}
const body = (value: unknown = { env: "prod", commit: "abc123" }) =>
  new TextEncoder().encode(JSON.stringify(value));
function signed(
  secret: string,
  options: { id?: string; seconds?: number; payload?: Uint8Array; method?: string } = {},
): WebhookRequest {
  const id = options.id ?? "evt_1";
  const seconds = options.seconds ?? start / 1000;
  const payload = options.payload ?? body();
  return {
    method: options.method ?? "POST",
    body: payload,
    headers: new Headers({
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(seconds),
      "webhook-signature": signWebhook(secret, id, seconds, payload),
    }),
  };
}

describe("webhook automations", () => {
  it("a signed request starts one run with the body's fields in its prompt", async () => {
    const { h, webhooks } = setup();
    const { hookId, secret } = webhooks().rotate("deploy");
    const answer = webhooks().receive(hookId, signed(secret));
    expect(answer.status).toBe(202);
    const input = await h.nextExecution(0);
    expect(input.prompt).toBe("Check the prod deploy of abc123");
    const runs = h.service.inbox().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "webhook", eventKey: "webhook:evt_1" });
    expect(answer.body).toEqual({ runId: runs[0]?.id });
  });

  it("a retried delivery returns its run instead of starting another, also after a restart", async () => {
    const { h, webhooks } = setup();
    const { hookId, secret } = webhooks().rotate("deploy");
    const first = webhooks().receive(hookId, signed(secret));
    expect(webhooks().receive(hookId, signed(secret)).body).toEqual(first.body);
    h.restart();
    expect(webhooks().receive(hookId, signed(secret)).body).toEqual(first.body);
    expect(h.service.inbox().runs).toHaveLength(1);
    expect(webhooks().receive(hookId, signed(secret, { id: "evt_2" })).status).toBe(202);
    expect(h.service.inbox().runs).toHaveLength(2);
  });

  it("refuses each kind of bad request with its own status and starts no run", () => {
    const { h, webhooks } = setup();
    const { hookId, secret } = webhooks().rotate("deploy");
    const other = webhooks().rotate("deploy").secret;
    const unsigned = signed(other);
    unsigned.headers.delete("webhook-signature");
    const plain = signed(other);
    plain.headers.set("content-type", "text/plain");
    const cases: [WebhookRequest, number, string][] = [
      [signed(other, { method: "GET" }), 405, "method_not_allowed"],
      [signed(secret), 401, "bad_signature"],
      [signed(other, { seconds: start / 1000 - 301 }), 400, "stale_timestamp"],
      [unsigned, 400, "bad_headers"],
      [plain, 415, "unsupported_media_type"],
      [signed(other, { payload: body({ text: "x".repeat(70_000) }) }), 413, "too_large"],
      [signed(other, { payload: new TextEncoder().encode("[1]") }), 422, "bad_body"],
    ];
    for (const [request, status, error] of cases) {
      const answer = webhooks().receive(hookId, request);
      expect([answer.status, answer.body]).toMatchObject([status, { error }]);
    }
    expect(webhooks().receive("0".repeat(32), signed(other))).toMatchObject({ status: 404 });
    expect(webhooks().receive("not-a-hook", signed(other))).toMatchObject({ status: 404 });
    expect(h.service.inbox().runs).toHaveLength(0);
  });

  it("an automation turned off refuses its webhook", () => {
    const { h, webhooks } = setup();
    const { hookId, secret } = webhooks().rotate("deploy");
    h.service.setEnabled("deploy", false);
    expect(webhooks().receive(hookId, signed(secret))).toMatchObject({
      status: 409,
      body: { error: "disabled" },
    });
    expect(h.service.inbox().runs).toHaveLength(0);
  });

  it("rotating keeps the URL and makes the old secret fail", () => {
    const { webhooks } = setup();
    const first = webhooks().rotate("deploy");
    const second = webhooks().rotate("deploy");
    expect(second.hookId).toBe(first.hookId);
    expect(second.secret).not.toBe(first.secret);
    expect(webhooks().receive(first.hookId, signed(first.secret)).status).toBe(401);
    expect(webhooks().receive(first.hookId, signed(second.secret)).status).toBe(202);
  });

  it("revoking, changing the trigger or deleting the automation retires its URL", () => {
    for (const retire of ["revoke", "retrigger", "remove"] as const) {
      const { h, webhooks } = setup();
      const { hookId, secret } = webhooks().rotate("deploy");
      if (retire === "revoke") webhooks().revoke("deploy");
      if (retire === "retrigger") h.service.put(definition({ id: "deploy" }));
      if (retire === "remove") h.service.remove("deploy");
      expect(webhooks().receive(hookId, signed(secret)).status).toBe(404);
      expect(webhooks().hookOf("deploy")).toBeUndefined();
    }
  });

  it("only a webhook automation can have a secret", () => {
    const { h, webhooks } = setup();
    h.service.put(definition({ id: "manual" }));
    expect(() => webhooks().rotate("manual")).toThrow();
    expect(() => webhooks().rotate("missing")).toThrow();
  });

  it("the secret never appears in lists or run history", async () => {
    const { h, webhooks } = setup();
    const { hookId, secret } = webhooks().rotate("deploy");
    webhooks().receive(hookId, signed(secret));
    await h.nextExecution(0);
    await h.finish(0);
    const listed = h.service.handle({ type: "automation.list", requestId: "l" });
    const inbox = h.service.handle({ type: "automation.inbox", requestId: "i", limit: 10 });
    const key = secret.slice("whsec_".length);
    for (const text of [JSON.stringify(listed), JSON.stringify(inbox), JSON.stringify(h.inputs)])
      expect(text).not.toContain(key);
  });
});
