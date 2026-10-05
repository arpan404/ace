import type { ScreenManager } from "../index.ts";

/** Standalone tests inject the human approval boundary; production uses engine interactions. */
export async function allowForeground(screen: ScreenManager, sessionId: string) {
  let enabled = true;
  const grants = new Map(screen.approvals().map((grant) => [grant.bundleId, grant]));
  screen.configureAccess({
    enabled: () => enabled,
    enable: (value) => {
      enabled = value;
    },
    list: () => [...grants.values()],
    allows: (bundle) => grants.has(bundle),
    approve(bundleId, allowed, scope, threadId) {
      if (allowed) grants.set(bundleId, { bundleId, scope, threadId, grantedAt: 0 });
      else grants.delete(bundleId);
    },
    async request() {
      throw new Error("App approval must be set up by the test human");
    },
    async foreground() {},
    audit() {},
  });
  await screen.mode(sessionId, "foreground");
}
