import { expect, test } from "vitest";
import type { OutsideGrant } from "@ace/protocol";
import { SpadeGrantDelivery } from "./delivery.ts";

const grant: OutsideGrant = {
  id: "spade-1",
  clientKind: "spade",
  clientId: "spade",
  name: "Spade",
  domain: null,
  scopes: ["threads:read"],
  projects: "all",
  createdAt: 1,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  approvedBy: "local",
};
const connection = { host: "127.0.0.1", port: 4100, token: "spade-token-xxxxxxxx" };

/** Delivery to a listener that proves itself (or not), recording what reached it. */
function delivery(proves: boolean) {
  const sent: string[] = [];
  let issued = 0;
  const handOver = new SpadeGrantDelivery({
    now: () => 100_000,
    grants: {
      current: () => grant,
      issue: () => `token-${++issued}`,
    },
    call: async (_connection, method, body) => {
      if (method === "GET") return { status: 200, body: { grant: sent.length > 0 } };
      sent.push(body ? `${method} ${body.grant}` : method);
      return { status: 204, body: undefined };
    },
    prove: async () => proves,
    ready: () => undefined,
    after: () => () => {},
    log: () => {},
  });
  return { handOver, sent, issued: () => issued };
}

test("a listener that can't prove it is Spade is sent neither a grant nor a revoke", async () => {
  const { handOver, sent, issued } = delivery(false);
  await handOver.deliver(connection, true);
  await handOver.withdraw(connection);
  expect(sent).toEqual([]);
  expect(issued()).toBe(0);
});

test("Spade proving itself gets its grant once, and is told to forget it", async () => {
  const { handOver, sent } = delivery(true);
  await handOver.deliver(connection, true);
  await handOver.deliver(connection);
  await handOver.withdraw(connection);
  expect(sent).toEqual(["PUT token-1", "DELETE"]);
});

test("a refused credential heals automatically, at most once a minute, and revocation stays revoked", async () => {
  let now = 100_000;
  let live = true;
  let refused = false;
  let stored = "";
  let valid = "";
  let issued = 0;
  let scheduled: (() => void) | undefined;
  const handOver = new SpadeGrantDelivery({
    now: () => now,
    grants: {
      current: () => (live ? grant : undefined),
      issue: () => {
        valid = `credential-${++issued}`;
        return valid;
      },
    },
    prove: async () => true,
    ready: () => connection,
    after: (_ms, run) => {
      scheduled = run;
      return () => {
        scheduled = undefined;
      };
    },
    log: () => {},
    call: async (_connection, method, body) => {
      if (method === "GET") return { status: 200, body: { grant: !!stored, refused } };
      if (body) {
        stored = body.grant;
        refused = false;
      }
      return { status: 204, body: undefined };
    },
  });
  const poll = async () => {
    const run = scheduled;
    if (!run) throw new Error("no automatic grant check was scheduled");
    scheduled = undefined;
    run();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await handOver.deliver(connection, true);
  const old = stored;
  refused = true;
  await poll();
  expect(stored).toBe(old);
  now += 60_000;
  await poll();
  expect(stored).not.toBe(old);
  expect(stored).toBe(valid);
  const healed = stored;
  refused = true;
  await poll();
  expect(stored).toBe(healed);
  live = false;
  now += 60_000;
  await poll();
  expect(stored).toBe(healed);
  handOver.close();
});
