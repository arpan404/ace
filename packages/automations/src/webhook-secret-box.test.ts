import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AutomationStore, AutomationWebhooks, signWebhook, webhookSecretBox } from "./index.ts";
import { definition, harness, start } from "./service-test-support.ts";

const keyOf = (fill: number) => () => new Uint8Array(32).fill(fill);
const bytes = (size: number) => new Uint8Array(size).fill(9);
function signed(secret: string) {
  const payload = new TextEncoder().encode("{}");
  const seconds = start / 1000;
  return {
    method: "POST",
    body: payload,
    headers: new Headers({
      "content-type": "application/json",
      "webhook-id": "evt_1",
      "webhook-timestamp": String(seconds),
      "webhook-signature": signWebhook(secret, "evt_1", seconds, payload),
    }),
  };
}

describe("webhook secrets at rest", () => {
  it("a copy of the store's files alone doesn't hold the secret", () => {
    const h = harness();
    h.service.put(definition({ id: "deploy", trigger: { kind: "webhook" }, prompt: "Go" }));
    const { secret } = new AutomationWebhooks(h.store, h.service, {
      now: () => start,
      randomBytes: bytes,
    }).rotate("deploy");
    const key = secret.slice("whsec_".length);
    for (const file of [h.storePath, `${h.storePath}-wal`])
      if (existsSync(file)) expect(readFileSync(file).toString("latin1")).not.toContain(key);
  });

  it("with another key the secret can't be read, so deliveries are refused and start nothing", () => {
    const h = harness();
    h.now = start;
    h.service.put(definition({ id: "deploy", trigger: { kind: "webhook" }, prompt: "Go" }));
    const { hookId, secret } = new AutomationWebhooks(h.store, h.service, {
      now: () => start,
      randomBytes: bytes,
    }).rotate("deploy");
    const other = new AutomationStore(h.storePath, { webhookSecrets: webhookSecretBox(keyOf(2)) });
    try {
      const answer = new AutomationWebhooks(other, h.service, {
        now: () => start,
        randomBytes: bytes,
      }).receive(hookId, signed(secret));
      expect(answer).toMatchObject({ status: 503, body: { error: "unavailable" } });
      expect(h.service.inbox().runs).toHaveLength(0);
    } finally {
      other.close();
    }
  });

  it("a store without a key can't make a secret", () => {
    const h = harness();
    const bare = new AutomationStore(h.storePath);
    try {
      h.service.put(definition({ id: "deploy", trigger: { kind: "webhook" }, prompt: "Go" }));
      expect(() =>
        new AutomationWebhooks(bare, h.service, { now: () => start, randomBytes: bytes }).rotate(
          "deploy",
        ),
      ).toThrow();
    } finally {
      bare.close();
    }
  });
});
