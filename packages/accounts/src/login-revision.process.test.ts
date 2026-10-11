import { afterEach, expect, test } from "vitest";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { openRegistry } from "./index.ts";
import { cleanup, homes } from "./test-support.ts";

afterEach(cleanup);

test("unknown auth probes preserve the account generation while confirmed auth changes revoke it", async () => {
  const fixture = await homes("codex");
  const registry = await openRegistry(fixture.to.homeDir + "/accounts.sqlite");
  try {
    await registry.register(fixture.from);
    const ingest = (auth: "logged_in" | "logged_out" | "unknown", observedAt: number) =>
      registry.ingest(fixture.from.id, {
        provider: "codex",
        payload: new ProviderPayload(JSON.stringify({ auth })),
        observedAt,
        timeZone: "UTC",
      });
    ingest("logged_in", 1);
    expect(registry.get(fixture.from.id)?.instance.loginRevision).toBe("1");
    ingest("unknown", 2);
    expect(registry.get(fixture.from.id)).toMatchObject({
      instance: { loginRevision: "1" },
      quota: { auth: "logged_in" },
    });
    ingest("logged_out", 3);
    expect(registry.get(fixture.from.id)?.instance.loginRevision).toBe("2");
    ingest("logged_in", 4);
    expect(registry.get(fixture.from.id)?.instance.loginRevision).toBe("3");
  } finally {
    registry.close();
  }
});

test("explicit auth invalidation clears obsolete identity and cannot revoke a newer login", async () => {
  const fixture = await homes("codex");
  const registry = await openRegistry(fixture.to.homeDir + "/accounts.sqlite");
  try {
    await registry.register(fixture.from);
    registry.recordAuth(fixture.from.id, "browser", "obsolete-account");
    registry.ingest(fixture.from.id, {
      provider: "codex",
      payload: new ProviderPayload('{"auth":"logged_in"}'),
      observedAt: 1,
      timeZone: "UTC",
    });
    expect(registry.invalidateAuth(fixture.from.id, "1")).toBe(true);
    expect(registry.get(fixture.from.id)).toMatchObject({
      instance: { authMethod: "unknown", loginRevision: "2" },
      quota: { auth: "unknown" },
    });
    expect(registry.get(fixture.from.id)?.instance.signedInAs).toBeUndefined();
    expect(registry.summary(fixture.from.id, 2)?.availability).toBe("unknown");
    registry.recordAuth(fixture.from.id, "api_key", "new-account");
    registry.ingest(fixture.from.id, {
      provider: "codex",
      payload: new ProviderPayload('{"auth":"logged_in"}'),
      observedAt: 3,
      timeZone: "UTC",
    });
    expect(registry.invalidateAuth(fixture.from.id, "1")).toBe(false);
    expect(registry.get(fixture.from.id)).toMatchObject({
      instance: { authMethod: "api_key", signedInAs: "new-account", loginRevision: "3" },
      quota: { auth: "logged_in" },
    });
  } finally {
    registry.close();
  }
});
