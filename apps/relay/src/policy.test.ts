import { expect, it } from "vitest";
import { IpBudget, readRelayConfig, RelayRoutes } from "./index.ts";
import { hostId, keyPair } from "@ace/secure-channel";
it("IPv6 addresses in a /64 share their connection and message budget", () => {
  const budget = new IpBudget({ maxConnectionsPerIp: 1, messageBurst: 1, messagesPerSecond: 1 });
  expect(budget.acquire("2001:db8:1234:5678::1", 0)).toBe(true);
  expect(budget.acquire("2001:db8:1234:5678:ffff::9", 0)).toBe(false);
  expect(budget.take("2001:0db8:1234:5678::2", 0)).toBe(0);
  expect(budget.take("2001:db8:1234:5678::3", 0)).toBe(1000);
  expect(budget.acquire("2001:db8:1234:5679::1", 0)).toBe(true);
});
it("IP admission evicts the least recently used inactive entry and retains every active quota", () => {
  const budget = new IpBudget({ maxIpEntries: 2, maxConnectionsPerIp: 1, messageBurst: 1 });
  expect(budget.acquire("192.0.2.1", 0)).toBe(true);
  budget.release("192.0.2.1", 0);
  expect(budget.acquire("192.0.2.2", 1)).toBe(true);
  budget.release("192.0.2.2", 1);
  expect(budget.acquire("192.0.2.1", 2)).toBe(true);
  budget.take("192.0.2.1", 2);
  budget.release("192.0.2.1", 2);
  expect(budget.acquire("192.0.2.3", 2)).toBe(true);
  expect(budget.acquire("192.0.2.1", 2)).toBe(true);
  expect(budget.take("192.0.2.1", 2)).toBeGreaterThan(0);
  expect(budget.acquire("192.0.2.4", 2)).toBe(false);
  expect(budget.acquire("192.0.2.3", 2)).toBe(false);
});
it("IPv4-mapped IPv6 cannot bypass an IPv4 connection quota", () => {
  const budget = new IpBudget({ maxConnectionsPerIp: 1 });
  expect(budget.acquire("192.0.2.1", 0)).toBe(true);
  expect(budget.acquire("::ffff:192.0.2.1", 0)).toBe(false);
  expect(budget.acquire("::ffff:c000:201", 0)).toBe(false);
});
it("connection churn does not discard earned message tokens", () => {
  const budget = new IpBudget({ messageBurst: 1, messagesPerSecond: 1 });
  budget.acquire("127.0.0.1", 0);
  expect(budget.take("127.0.0.1", 0)).toBe(0);
  budget.acquire("127.0.0.1", 1000);
  expect(budget.take("127.0.0.1", 1000)).toBe(0);
});
it("environment configuration rejects ambiguous numbers and inconsistent limits", () => {
  for (const value of ["NaN", "Infinity", "1e3", "1.5", "-1", "0", ""])
    expect(() => readRelayConfig({ ACE_RELAY_MESSAGES_PER_SECOND: value })).toThrow();
  expect(() => readRelayConfig({ ACE_RELAY_PORT: "65536" })).toThrow();
  expect(() =>
    readRelayConfig({ ACE_RELAY_HIGH_WATER_BYTES: "1024", ACE_RELAY_MAX_BUFFERED_BYTES: "512" }),
  ).toThrow();
  expect(() => readRelayConfig({ ACE_RELAY_ALLOWED_HOST_IDS: "invalid" })).toThrow();
  expect(
    readRelayConfig({ ACE_RELAY_MESSAGES_PER_SECOND: "50", ACE_RELAY_ALLOWED_HOST_IDS: "" }),
  ).toMatchObject({ limits: { messagesPerSecond: 50 }, allowedHostIds: [] });
});
it("only the offering host may reject an outstanding client ticket", () => {
  const routes = new RelayRoutes({ ticketTimeoutMs: 100 });
  const id = hostId(keyPair().publicKey);
  const ticket = "a".repeat(64);
  routes.register("owner", id);
  routes.request("client", id, ticket, 0);
  expect(routes.reject("stranger", ticket)).toEqual([]);
  expect(routes.join("join", ticket, 1)).toEqual([
    { type: "pair", client: "client", host: "join" },
  ]);
});
