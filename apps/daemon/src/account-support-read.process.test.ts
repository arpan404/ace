import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openRegistry } from "@ace/accounts";
import { ProviderInstance } from "@ace/protocol/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { inspectAccountSupport } from "./provider-account-support.ts";
import { fakeCli } from "./provider-status-test-support.ts";

test("reading provider account support never changes the registered login or quota", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-account-support-"));
  const bin = join(home, "bin");
  await mkdir(bin);
  await fakeCli(bin, "claude", "2.1.286", '{"loggedIn":false}', "auth status");
  const registry = await openRegistry(join(home, "accounts.sqlite"));
  const instance = ProviderInstance.parse({
    id: "claude-cli-default",
    implicit: true,
    provider: "claude",
    label: "CLI",
    homeDir: home,
    env: {},
  });
  try {
    await registry.register(instance);
    registry.ingest(instance.id, {
      provider: "claude",
      observedAt: 100,
      timeZone: "UTC",
      payload: new ProviderPayload('{"auth":"logged_in"}'),
    });
    const before = registry.summary(instance.id, 100);
    await inspectAccountSupport("claude", {
      registry,
      env: { HOME: home, PATH: bin },
      now: () => 200,
    });
    expect(registry.summary(instance.id, 200)?.quota).toEqual(before?.quota);
    expect(registry.summary(instance.id, 200)?.loginRevision).toBe(before?.loginRevision);
  } finally {
    registry.close();
    await rm(home, { recursive: true, force: true });
  }
});
