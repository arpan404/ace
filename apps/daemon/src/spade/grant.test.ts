import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { draft, grantFixture } from "../external-mcp/grant-test-support.ts";
import { OutsideAccess } from "../external-mcp/outside.ts";
import { GrantStore } from "../external-mcp/grants.ts";
import { GrantTokens } from "../external-mcp/tokens.ts";
import { OlderOutsideResult } from "../spade-test-support.ts";
import { SpadeGrantDelivery } from "./delivery.ts";
import { SpadeGrants } from "./grant.ts";

/** Outside clients' grants and Spade's over one database, as the daemon keeps them. */
function machine() {
  const f = grantFixture();
  let next = 0;
  const outside = new OutsideAccess({
    sql: f.sql,
    now: () => f.clock.now,
    id: () => `outside-${++next}`,
    ended: () => {},
    closeBrowser: () => {},
  });
  const store = new GrantStore(
    f.sql,
    () => f.clock.now,
    () => `spade-${++next}`,
  );
  const spade = new SpadeGrants(
    store,
    new GrantTokens({ sql: f.sql, grants: store, now: () => f.clock.now, random: randomBytes }),
    () => f.clock.now,
  );
  /** What `outside.request {op: "grants"}` (and `ace mcp list`) sends. */
  const listed = () => ({
    type: "outside.result",
    requestId: "list",
    result: { kind: "grants", grants: outside.grants.entries() },
  });
  return { f, outside, spade, listed };
}

test("the outside clients' list never holds Spade's grant, live or ended", () => {
  const { f, outside, spade, listed } = machine();
  const client = outside.grants.create(draft({ name: "Claude" }));
  const first = spade.ensure();
  f.clock.now += 1;
  spade.retireAll(f.clock.now);
  const second = spade.ensure();
  const names = listed().result.grants.map((grant) => grant.id);
  expect(names).toEqual([client.id]);
  expect(names).not.toContain(first.id);
  expect(names).not.toContain(second.id);
  // ... nor can it be revoked or changed as an outside client's grant.
  expect(outside.revoke(second.id)).toBe(false);
  expect(outside.update(second.id, { scopes: ["threads:read"] })).toBeUndefined();
  expect(spade.current()?.id).toBe(second.id);
});

test("an app from before Spade's grant still reads the outside clients' list with one present", () => {
  const { outside, spade, listed } = machine();
  outside.grants.create(draft({ name: "Claude" }));
  spade.ensure();
  const older = OlderOutsideResult.safeParse(listed());
  expect(older.success).toBe(true);
  expect(older.data?.result.grants.map((grant) => grant.name)).toEqual(["Claude"]);
});

test("Spade's status shows its grant: present, used, then revoked by the person and not remade", () => {
  const { f, spade } = machine();
  expect(spade.summary()).toBeUndefined();
  const token = spade.issue(spade.ensure());
  expect(spade.summary()).toEqual({ state: "present", lastUsedAt: null });
  f.clock.now += 5;
  expect(spade.verify(token)).toBeDefined();
  expect(spade.summary()).toEqual({ state: "present", lastUsedAt: f.clock.now });

  const used = f.clock.now;
  expect(spade.revoke()).toBeDefined();
  expect(spade.verify(token)).toBeUndefined();
  expect(spade.summary()).toEqual({ state: "revoked", lastUsedAt: used });
  // Revoked by the person: a restarted daemon doesn't make another.
  expect(spade.wanted()).toBe(false);
  expect(spade.revoke()).toBeUndefined();
});

test("a timed-out handover cannot overwrite the acknowledged grant with a refused token", async () => {
  const { spade } = machine();
  spade.ensure();
  let stored = "";
  let finishSlowWrite: (() => void) | undefined;
  let puts = 0;
  const connection = { host: "127.0.0.1", port: 4100, token: "test-spade-token" };
  const delivery = new SpadeGrantDelivery({
    now: () => 100_000,
    grants: spade,
    prove: async () => true,
    ready: () => connection,
    after: () => () => {},
    log: () => {},
    call: async (_connection, method, body) => {
      if (method === "GET") return { status: 200, body: { grant: !!stored } };
      if (!body) return undefined;
      const token = body.grant;
      if (++puts === 1) {
        // The HTTP deadline expires, but Spade's off-thread keychain write keeps running.
        finishSlowWrite = () => {
          stored = token;
        };
        return undefined;
      }
      stored = token;
      return { status: 204, body: undefined };
    },
  });
  await delivery.deliver(connection, true);
  await delivery.deliver(connection, true);
  expect(spade.verify(stored)).toBeDefined();
  // The first PUT finishes after the retry has been acknowledged.
  finishSlowWrite?.();
  expect(spade.verify(stored)).toBeDefined();
  delivery.close();
});
