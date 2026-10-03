import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AccountRegistry, createInstance } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { setup } from "./test-support.ts";

test("explicit exhausted or mismatched accounts are rejected without creating children and eligible accounts are retained", async () => {
  const db = new DatabaseSync(":memory:"),
    accounts = new AccountRegistry(db);
  const h = setup({}, undefined, false, undefined, false, accounts);
  try {
    await accounts.register(
      createInstance({
        id: "claude-quota",
        provider: "claude",
        label: "Claude",
        homeDir: join(h.home, "claude"),
      }),
    );
    await accounts.register(
      createInstance({
        id: "codex-other",
        provider: "codex",
        label: "Codex",
        homeDir: join(h.home, "codex"),
      }),
    );
    const parent = await h.parent();
    const request = {
      requestId: "quota",
      provider: "claude" as const,
      accountId: "claude-quota",
      task: "work",
      role: "worker",
      wait: false,
      estimatedLoad: 0,
    };
    accounts.ingest("claude-quota", {
      provider: "claude",
      payload: new ProviderPayload(
        JSON.stringify({ auth: "logged_in", error: "usage limit reached" }),
      ),
      observedAt: 1000,
      timeZone: "UTC",
    });
    expect(() => h.service.delegate(parent, request)).toThrow(/quota exhausted/);
    expect(() =>
      h.service.delegate(parent, { ...request, requestId: "mismatched", accountId: "codex-other" }),
    ).toThrow(/Account unavailable/);
    expect(h.store.listThreads()).toHaveLength(1);
    // Use a separate eligible native account rather than changing an exhausted assignment.
    await accounts.register(
      createInstance({
        id: "claude-eligible",
        provider: "claude",
        label: "eligible",
        homeDir: join(h.home, "eligible"),
      }),
    );
    accounts.ingest("claude-eligible", {
      provider: "claude",
      payload: new ProviderPayload(JSON.stringify({ auth: "logged_in" })),
      observedAt: 1000,
      timeZone: "UTC",
    });
    const child = h.service.delegate(parent, {
      ...request,
      requestId: "eligible",
      accountId: "claude-eligible",
    });
    await h.engine.flush();
    expect(h.contexts.get(child.childId)?.instanceId).toBe("claude-eligible");
  } finally {
    await h.close();
    db.close();
  }
});
