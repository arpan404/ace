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
