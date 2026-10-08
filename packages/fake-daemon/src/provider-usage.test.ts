import { expect, it } from "vitest";
import { ClientMessage, ServerMessage, type ServerMessage as Message } from "@ace/protocol";
import { FakeServices } from "./services/index.ts";

it("provider demo reports API costs, unpriced tokens and per-account monthly series", () => {
  const now = Date.parse("2026-10-07T12:00Z");
  const messages: Message[] = [];
  const push = (message: Message) => messages.push(ServerMessage.parse(message));
  const services = new FakeServices({ clock: () => now, thread: () => undefined, broadcast: push });
  const query = {
    from: "2026-10-01",
    to: "2026-10-07",
    groupBy: ["account"],
    filters: { provider: ["opencode"] },
  };
  services.handle(ClientMessage.parse({ type: "usage.summary", requestId: "api", query }), push);
  const result = messages.at(-1);
  if (result?.type !== "usage.result") throw new Error("Missing usage reply");
  expect(result.result.accounts?.find((a) => a.id === "opencode-api")?.quota.billingMode).toBe(
    "api",
  );
  const totals = result.result.rows[0]?.totals;
  expect(totals?.estimatedUsd).toBeGreaterThan(0);
  expect(totals?.unpricedTokens).toBeGreaterThan(0);
  expect(result.result.costLabel).toBe("estimate");
  services.handle(
    ClientMessage.parse({
      type: "usage.series",
      requestId: "month",
      query: { ...query, bucket: "month", filters: { account: ["opencode-api"] } },
    }),
    push,
  );
  expect(messages.at(-1)).toMatchObject({
    type: "usage.result",
    result: {
      rows: [
        {
          dimensions: { day: "2026-10-01", account: "opencode-api" },
          totals: { estimatedUsd: totals?.estimatedUsd },
        },
      ],
    },
  });
  services.handle(
    ClientMessage.parse({
      type: "usage.summary",
      requestId: "subscription",
      query: { ...query, filters: { provider: ["claude"] } },
    }),
    push,
  );
  const plan = messages.at(-1);
  if (plan?.type !== "usage.result") throw new Error("Missing plan reply");
  expect(
    plan.result.rows.every(
      (r) =>
        r.totals.estimatedUsd === 0 &&
        r.totals.providerReportedUsd === 0 &&
        r.totals.subscriptionTokens > 0,
    ),
  ).toBe(true);
  expect(plan.result.accounts?.some((a) => a.availability === "near_limit")).toBe(true);
  const account = services.accounts.find((a) => a.id === "codex-team");
  if (!account) throw new Error("Missing limited account");
  services.updateQuota(account.id, {
    ...account.quota,
    windows: {
      primary: { usedPercent: 100, remainingPercent: 0, resetsAt: now + 60000, source: "cli" },
    },
  });
  expect(messages.at(-1)).toMatchObject({
    type: "usage.limits_changed",
    account: { id: "codex-team", availability: "exhausted", blockedUntil: now + 60000 },
  });
});
