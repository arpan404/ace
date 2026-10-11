import { expect, test } from "vitest";
import { createModelDiscovery } from "@ace/models";
import { nativeLoginHarness } from "./native-login-test-support.ts";
import { startProviderStatuses } from "./services/provider-status.ts";

const cases = ["catalog", "status"].flatMap((phase) =>
  ["binary path", "disabled", "login revision", "selected account", "unchanged"].map((change) => ({
    phase,
    change,
  })),
);

test.each(cases)(
  "a $change change during $phase completion cannot publish stale login success",
  async ({ phase, change }) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const discover = createModelDiscovery();
    const f = await nativeLoginHarness("codex", async (instance, context) => {
      const result = await discover(instance, context);
      if (phase === "catalog") {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    try {
      let completing = false;
      const options = f.context.options.providerStatus;
      if (!options) throw new Error("Missing status fixture options");
      options.versions = async (row) => {
        if (phase === "status" && completing && row.provider === "codex") {
          entered.resolve();
          await release.promise;
        }
        return {};
      };
      await startProviderStatuses(f.context);
      const statuses = f.context.services.providerStatuses;
      if (!statuses) throw new Error("Missing provider statuses");
      await statuses.refresh();
      completing = true;
      const session = await f.start("api_key");
      await f.wait("awaiting_api_key");
      await f.sessions.handle("owner", {
        type: "provider.login.apiKey",
        requestId: "key",
        session,
        apiKey: "opaque-synthetic-completion",
      });
      await entered.promise;
      expect(f.f.registry.summary(f.instance.id, 100)?.quota.auth).toBe("logged_in");
      if (change === "selected account") f.f.registry.selectProvider("codex", (await f.f.add()).id);
      else if (change === "login revision") f.f.registry.loginChanged(f.instance.id);
      else if (change !== "unchanged")
        await f.configure(
          change === "binary path" ? { binaryPath: f.replacement } : { enabled: false },
        );
      const revision = f.f.registry.get(f.instance.id)?.instance.loginRevision;
      release.resolve();
      expect((await f.sessions.completed("owner", session)).state).toBe(
        change === "unchanged" ? "succeeded" : "failed",
      );
      expect(f.f.accounts.isChangingAccount(f.instance.id)).toBe(false);
      expect(f.f.models.hasInstance(f.instance.id)).toBe(change === "unchanged");
      if (change === "unchanged")
        expect(
          f.f.models.list({ instance: f.instance.id }).models.map((row) => row.nativeModelId),
        ).toContain("configured-login-model");
      else expect(f.f.models.list({ instance: f.instance.id }).models).toEqual([]);
      expect(f.f.registry.summary(f.instance.id, 100)?.quota.auth).toBe(
        change === "binary path" ? "unknown" : "logged_in",
      );
      if (change === "login revision")
        expect(f.f.registry.get(f.instance.id)?.instance.loginRevision).toBe(revision);
      await statuses.refreshAfterMutation();
      const status = statuses.list().find((row) => row.provider === "codex");
      expect(status?.readiness).toBe(
        change === "disabled"
          ? "not_configured"
          : change === "binary path" || change === "selected account"
            ? "installed_signed_out"
            : "signed_in",
      );
      if (change === "binary path") expect(status?.authMethod).toBe("unknown");
      expect(f.events.some((event) => event.state === "succeeded")).toBe(change === "unchanged");
    } finally {
      release.resolve();
      await f.close();
    }
  },
);
