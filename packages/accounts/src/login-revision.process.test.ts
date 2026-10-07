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
      quota: { auth: "unknown" },
    });
    ingest("logged_out", 3);
    expect(registry.get(fixture.from.id)?.instance.loginRevision).toBe("2");
    ingest("logged_in", 4);
    expect(registry.get(fixture.from.id)?.instance.loginRevision).toBe("3");
  } finally {
    registry.close();
  }
});
