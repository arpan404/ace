import { expect, test } from "vitest";
import type { ProviderMcpControl } from "@ace/engine-api";
import { AceListing } from "./ace-listing.ts";

const connection = { url: "http://127.0.0.1:9012/mcp", bearer: "b".repeat(64) };
const toolSearchOn = { env: {} };
const claude3 = { env: {}, model: "claude-3-5-haiku-20241022" };

/** Claude Code's MCP set as the fake CLI holds it; `failures` replacements are refused first. */
function provider(failures: number) {
  const state = { connected: {} as Record<string, unknown>, failures };
  const control: ProviderMcpControl = {
    async status() {
      return [];
    },
    async replace(servers) {
      if (state.failures-- > 0) throw new Error("Claude MCP connection failures: ace: refused");
      state.connected = servers;
      return { added: Object.keys(servers), removed: [], errors: {} };
    },
    async reconnect() {},
    async enable() {},
    async disable() {},
  };
  return { control, state };
}
function aceTools(servers: Record<string, unknown>): unknown {
  const ace = servers["ace"] as { headers?: Record<string, string> } | undefined;
  return ace ? (ace.headers?.["X-Ace-Tools"] ?? "all") : undefined;
}

test("a narrowing whose reconnect failed is retried and the session ends on the core listing", async () => {
  const { control, state } = provider(1);
  const listing = new AceListing(connection, "all", {});
  await expect(listing.update(claude3, control)).rejects.toThrow("refused");
  expect(listing.unsettled).toBe(true);
  await listing.settle(control);
  expect(aceTools(state.connected)).toBe("core");
  expect(listing.unsettled).toBe(false);
});

test("a later model switch after a failed narrowing still reconnects ace with core", async () => {
  const { control, state } = provider(1);
  const listing = new AceListing(connection, "all", {});
  await expect(listing.update(claude3, control)).rejects.toThrow("refused");
  // Rolling back to a model with tool search never widens the list again, but reconnects.
  await listing.update(toolSearchOn, control);
  expect(aceTools(state.connected)).toBe("core");
});

test("a caller's own replacement after a failed narrowing installs the core listing", async () => {
  const { control, state } = provider(1);
  const listing = new AceListing(connection, "all", {});
  await expect(listing.update(claude3, control)).rejects.toThrow("refused");
  await listing.controls(control).replace({ ace: { type: "http", url: connection.url } });
  expect(aceTools(state.connected)).toBe("core");
  expect(listing.unsettled).toBe(false);
});

/**
 * Claude Code's MCP set when replies come back only as the test releases them. Claude Code
 * applies replacements in the order they arrive; `refuse` marks submissions it rejects.
 */
function slowProvider(refuse: (call: number) => boolean = () => false) {
  const state = { connected: {} as Record<string, unknown>, open: 0, mostOpen: 0, calls: 0 };
  const waiting: Array<() => void> = [];
  const control: ProviderMcpControl = {
    ...provider(0).control,
    replace(servers) {
      const call = state.calls++;
      state.open += 1;
      state.mostOpen = Math.max(state.mostOpen, state.open);
      return new Promise((resolve, reject) => {
        waiting.push(() => {
          state.open -= 1;
          if (refuse(call)) return reject(new Error("Claude MCP connection failures: refused"));
          state.connected = servers;
          resolve({ added: Object.keys(servers), removed: [], errors: {} });
        });
      });
    },
  };
  /** Answers every submission, including ones sent after earlier answers, until all settle. */
  async function drain(...pending: Promise<unknown>[]) {
    let done = false;
    const all = Promise.allSettled(pending).then((results) => {
      done = true;
      return results;
    });
    while (!done) {
      waiting.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return all;
  }
  return { control, state, drain };
}
const extra = { type: "http", url: "http://127.0.0.1:9013/mcp" };

test("a narrowing that races a caller's replacement adding a server keeps both", async () => {
  const { control, state, drain } = slowProvider();
  const listing = new AceListing(connection, "all", {});
  const added = listing.controls(control).replace({ extra });
  const narrowed = listing.update(claude3, control);
  await drain(added, narrowed);
  expect(state.connected).toHaveProperty("extra");
  expect(aceTools(state.connected)).toBe("core");
  expect(listing.unsettled).toBe(false);
});

test("a caller's failed replacement is kept, and the next successful one installs it", async () => {
  const { control, state, drain } = slowProvider((call) => call === 0);
  const listing = new AceListing(connection, "all", {});
  const [failed] = await drain(listing.controls(control).replace({ extra }));
  expect(failed?.status).toBe("rejected");
  expect(listing.unsettled).toBe(true);
  await drain(listing.update(claude3, control));
  expect(state.connected).toHaveProperty("extra");
  expect(aceTools(state.connected)).toBe("core");
  expect(listing.unsettled).toBe(false);
});

test("concurrent replacements reach Claude Code one at a time and the last intended set wins", async () => {
  const { control, state, drain } = slowProvider();
  const listing = new AceListing(connection, "all", {});
  const mcp = listing.controls(control);
  const first = mcp.replace({ first: extra });
  const narrowed = listing.update(claude3, control);
  const second = mcp.replace({ second: extra });
  await drain(first, narrowed, second);
  expect(state.mostOpen).toBe(1);
  expect(Object.keys(state.connected).toSorted()).toEqual(["ace", "second"]);
  expect(aceTools(state.connected)).toBe("core");
});

test("many retries asked for while one is queued send a single reconnect", async () => {
  const { control, state, drain } = slowProvider((call) => call === 0);
  const listing = new AceListing(connection, "all", {});
  await drain(listing.update(claude3, control));
  const before = state.calls;
  await drain(listing.settle(control), listing.settle(control), listing.settle(control));
  expect(state.calls - before).toBe(1);
  expect(aceTools(state.connected)).toBe("core");
});
