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

  it("a sealed secret opens with its key and automation, and not once changed or moved", () => {
    const box = webhookSecretBox(keyOf(3));
    const sealed = box.seal("whsec_abc", "deploy");
    expect(box.open(sealed, "deploy")).toBe("whsec_abc");
    expect(box.open(sealed, "other")).toBeUndefined();
    const parts = sealed.split(".");
    const data = Buffer.from(parts[3] ?? "", "base64");
    data[0] = (data[0] ?? 0) ^ 1;
    expect(
      box.open([...parts.slice(0, 3), data.toString("base64")].join("."), "deploy"),
    ).toBeUndefined();
    expect(webhookSecretBox(keyOf(4)).open(sealed, "deploy")).toBeUndefined();
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

describe("delivery receipts", () => {
  it("each delivery clears a bounded batch of expired receipts, so a backlog never stalls one", () => {
    const h = harness();
    const keys = h.store.webhooks;
    const old = Array.from({ length: 200 }, (_, i) => `webhook:old${i}`);
    for (const key of old) keys.deliver("deploy", key, `run-${key}`, 1000, 0);
    const left = () => old.filter((key) => keys.delivered("deploy", key) !== undefined).length;
    keys.deliver("deploy", "webhook:new-1", "run-new-1", 100_000, 5000);
    expect(left()).toBeGreaterThan(0);
    expect(left()).toBeLessThan(old.length);
    for (let i = 2; i <= 10; i++)
      keys.deliver("deploy", `webhook:new-${i}`, `run-new-${i}`, 100_000, 5000);
    expect(left()).toBe(0);
    // Receipts not yet expired stay.
    expect(keys.delivered("deploy", "webhook:new-1")).toBe("run-new-1");
  });
});
