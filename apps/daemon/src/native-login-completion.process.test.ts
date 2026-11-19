import { expect, test } from "vitest";
import { createModelDiscovery } from "@ace/models";
import { nativeLoginHarness, within } from "./native-login-test-support.ts";
import { startProviderStatuses } from "./services/provider-status.ts";

const cases = ["catalog", "status"].flatMap((phase) =>
  ["binary path", "disabled", "login revision", "selected account", "unchanged"].map((change) => ({
    phase,
    change,
  })),
);

// Each step below is bounded; this caps the whole case, harness setup and teardown included.
const CASE_TIMEOUT_MS = 30_000;

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
      startProviderStatuses(f.context);
      const statuses = f.context.services.providerStatuses;
      if (!statuses) throw new Error("Missing provider statuses");
      await within(statuses.refresh(), () => "the first provider status refresh");
      // The daemon shares startup's CLI reads only until it listens, and a login can only arrive
      // after that. This harness has no engine or listener to end the share, so end it here.
      f.context.services.startupProbes?.close();
      completing = true;
      const session = await within(f.start("api_key"), () => "the login to start");
      await f.wait("awaiting_api_key");
      await within(
        f.sessions.handle("owner", {
          type: "provider.login.apiKey",
          requestId: "key",
          session,
          apiKey: "opaque-synthetic-completion",
        }),
        () => "the API key to be accepted",
      );
      // A login that fails before this step never enters it: say so instead of waiting forever.
      await within(
        entered.promise,
        () => `completion to reach its ${phase} step; the login reported ${f.describe()}`,
      );
      expect(f.f.registry.summary(f.instance.id, 100)?.quota.auth).toBe("logged_in");
      if (change === "selected account") f.f.registry.selectProvider("codex", (await f.f.add()).id);
      else if (change === "login revision") f.f.registry.loginChanged(f.instance.id);
      else if (change !== "unchanged")
        await f.configure(
          change === "binary path" ? { binaryPath: f.replacement } : { enabled: false },
        );
      const revision = f.f.registry.get(f.instance.id)?.instance.loginRevision;
      release.resolve();
      const completed = await within(
        f.sessions.completed("owner", session),
        () => `the login to finish; it reported ${f.describe()}`,
      );
      expect(completed.state).toBe(change === "unchanged" ? "succeeded" : "failed");
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
      await within(
        statuses.refreshAfterMutation(),
        () => "the provider status refresh after login",
      );
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
      await within(f.close(), () => "the login harness to close");
    }
  },
  CASE_TIMEOUT_MS,
);
