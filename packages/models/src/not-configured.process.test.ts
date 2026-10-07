import { expect, test } from "vitest";
import { ModelCatalog, ModelInstance, normalizeCodex, openModelStorage } from "./index.ts";
import { join } from "node:path";
import { Clock, codexPayload, instance, workspace } from "./testing/support.ts";

test.each(["cursor", "codex"] as const)(
  "unsigned-in %s discovery is informational until refresh, login change or max age",
  async (provider) => {
    const work = await workspace();
    const clock = new Clock();
    const config = ModelInstance.parse({
      ...instance(provider),
      ...(provider === "cursor" ? { backend: "cursor-sdk", homeDir: work.path } : {}),
      cwd: work.path,
    });
    let configured = false;
    let probes = 0;
    const logs: unknown[] = [];
    const maxAgeProbe = Promise.withResolvers<void>();
    const catalog = new ModelCatalog({
      instances: [config],
      storage: openModelStorage(join(work.path, "models.sqlite")),
      now: () => clock.now,
      ttlMs: 1000,
      retryMs: 20,
      deadline: clock.deadline,
      discover: async () => {
        probes++;
        if (probes === 3) maxAgeProbe.resolve();
        if (!configured) throw { code: "not_configured" };
        return normalizeCodex(codexPayload(), config);
      },
      onError: (_provider, _instance, error, _source, diagnostic) =>
        logs.push({ error, diagnostic }),
    });
    try {
      await catalog.refresh();
      expect(catalog.list().instances[0]).toMatchObject({
        stale: false,
        refreshing: false,
        errorDetail: { code: "not_configured", severity: "info", actionId: "provider.sign_in" },
      });
      expect(catalog.list().instances[0]?.error).toBeUndefined();
      expect(logs).toEqual([
        expect.objectContaining({ diagnostic: expect.objectContaining({ level: "info" }) }),
      ]);
      clock.now += 999;
      catalog.list();
      catalog.revalidate();
      expect(catalog.list().instances[0]?.refreshing).toBe(false);
      expect(probes).toBe(1);
      // An explicit refresh bypasses max-age without accumulating failure retries.
      await catalog.refresh();
      expect(probes).toBe(2);
      expect(logs).toHaveLength(1);
      clock.now += 1000;
      catalog.list();
      await maxAgeProbe.promise;
      await catalog.refresh();
      expect(probes).toBe(3);
      configured = true;
      await catalog.loginChanged(config.id, "login-2");
      await catalog.refresh();
      expect(catalog.list().models[0]?.id).toBe("coder");
      expect(catalog.list().instances[0]?.errorDetail).toBeUndefined();
    } finally {
      await catalog.close();
      await work.close();
    }
  },
);
