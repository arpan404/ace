import { expect, test } from "vitest";
import { SpadeLink } from "../spade/link.ts";
import { spadeSwitch, type SpadeSwitchDeps } from "./spade-switch.ts";

/** A switch over a real link on a machine where the service registers but Spade never answers. */
function machine(change: Partial<Pick<SpadeSwitchDeps, "host" | "grants">>) {
  let registered = false;
  const link = new SpadeLink({
    dataDir: "/ace/spade",
    runtime: {
      readText: async () => undefined,
      health: async () => undefined,
      alive: () => false,
      nonce: () => "0".repeat(32),
      serviceState: async () => (registered ? "running" : "absent"),
      watch: () => () => {},
      now: () => 0,
      after: () => () => {},
    },
  });
  const toggle = spadeSwitch({
    service: {
      state: async () => (registered ? "running" : "absent"),
      installBinary: async () => {},
      register: async () => {
        registered = true;
      },
      remove: async () => {
        registered = false;
      },
    },
    link,
    grants: {
      current: () => undefined,
      ensure: () => {
        throw new Error("unused");
      },
      wanted: () => true,
      retireAll: () => [],
      ...change.grants,
    },
    host: { ensure: async () => undefined, ...change.host },
    delivery: { deliver: async () => {}, withdraw: async () => {} },
    endLease: () => {},
    now: () => 0,
    log: () => {},
  });
  return { link, toggle };
}

test.each<[string, Partial<Pick<SpadeSwitchDeps, "host" | "grants">>]>([
  [
    "healing the host thread",
    {
      host: {
        ensure: async () => {
          throw new Error("the engine refused the host thread");
        },
      },
    },
  ],
  [
    "making the grant",
    {
      grants: {
        current: () => undefined,
        wanted: () => true,
        retireAll: () => [],
        ensure: () => {
          throw new Error("the grant couldn't be stored");
        },
      },
    },
  ],
])("Spade turned on is failed, not left starting, when %s throws", async (_step, change) => {
  const { link, toggle } = machine(change);
  await toggle.set(true, "changed");
  await link.refresh();
  expect(link.status()).toMatchObject({
    state: "failed",
    reason: expect.stringContaining("Turning Spade on failed"),
  });
});
