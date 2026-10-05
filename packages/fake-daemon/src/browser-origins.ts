import { originAccess, BrowserOriginError, browserOrigin } from "@ace/browser/policy";
import { PermissionMode, ThreadId } from "@ace/protocol";
import type { FakeBrowser } from "./browser.ts";
import type { FakeServiceContext } from "./service-context.ts";
import type { FakeSettings } from "./services/settings.ts";

/** Scripted agent navigation publishes the same approval facts used by the real daemon. */
export function bindFakeBrowserOrigins(
  browser: FakeBrowser,
  host: FakeServiceContext,
  settings: FakeSettings,
): void {
  let sequence = 0;
  const privateGates = new Map<string, string>();
  browser.bindPrivateLifecycle((threadId, paused) => {
    if (!host.apply) return;
    if (paused && !privateGates.has(threadId)) {
      const key = `browser-private-${++sequence}`;
      privateGates.set(threadId, key);
      host.apply(threadId, [
        {
          type: "interaction.opened",
          agent: "root",
          interaction: key,
          blocking: true,
          request: {
            kind: "plan_review",
            title: "Private browser ownership",
            markdown: "Take over again and hand back control to resume the agent.",
          },
          raw: [{ type: "ace.browser.private", data: { key } }],
        },
      ]);
    } else if (!paused) {
      const key = privateGates.get(threadId);
      if (key) {
        host.apply(threadId, [{ type: "interaction.closed", interaction: key, state: "resolved" }]);
        privateGates.delete(threadId);
      }
    }
  });
  const pending = new Map<string, (option?: string) => void>();
  host.onResolved?.((threadId, key, resolution) => {
    pending.get(`${threadId}:${key}`)?.(
      resolution?.kind === "approval" ? resolution.optionId : undefined,
    );
  });
  browser.bindNavigation(async (threadId, url) => {
    const origin = browserOrigin(url);
    if (!origin || !/^https?:\/\//i.test(url))
      throw new BrowserOriginError(url, "invalid_origin", "Browser requires an HTTP(S) address");
    const view = host.thread(threadId);
    if (!view) throw new Error("thread_not_found");
    const mode = PermissionMode.parse(
      view.thread.permission?.effective ??
        settings.resolve("permissions.defaultMode", { threadId: ThreadId.parse(threadId) }),
    );
    const allowed = settings.get("browser.allowedOrigins");
    const decision = originAccess({
      origin,
      mode,
      human: false,
      navigation: true,
      granted:
        browser.originsList(threadId).some((grant) => grant.origin === origin) ||
        (Array.isArray(allowed) && allowed.includes(origin)),
    });
    if (decision === "read_only")
      throw new BrowserOriginError(
        origin,
        "read_only",
        "Read-only mode refuses agent browser navigation",
      );
    if (decision === "page_grant") {
      browser.originsPageGrant(threadId, origin, host.now());
      return;
    }
    if (decision === "allow") return;
    if (!host.apply || !host.onResolved || !view.thread.rootAgentId)
      throw new BrowserOriginError(
        origin,
        "approval_required",
        "Browser approval requires an active thread agent",
      );
    if (pending.size >= 32) throw new Error("Browser approval limit");
    const key = `browser-origin-${++sequence}`,
      pendingKey = `${threadId}:${key}`;
    const action = `open ${origin} in the thread browser`;
    const option = await new Promise<string | undefined>((resolve) => {
      const finish = (answer?: string) => {
        clearTimeout(timer);
        pending.delete(pendingKey);
        resolve(answer);
      };
      const timer = setTimeout(() => {
        host.apply?.(threadId, [
          { type: "interaction.closed", interaction: key, state: "expired" },
        ]);
        finish();
      }, 60_000);
      pending.set(pendingKey, finish);
      host.apply?.(threadId, [
        {
          type: "interaction.opened",
          agent: "root",
          interaction: key,
          blocking: true,
          request: {
            kind: "approval",
            title: action,
            description: action,
            target: {
              tool: "ace_browser_navigate",
              access: "execute",
              input: { action, origin, url },
            },
            options: [
              { id: "allow_once", label: "Allow once", kind: "allow_once" },
              { id: "allow_thread", label: "Allow for this thread", kind: "allow_session" },
              { id: "deny", label: "Deny", kind: "deny" },
            ],
            defaultToNo: true,
          },
          raw: [{ type: "ace.browser.origin", data: { origin } }],
        },
      ]);
    });
    if (!option) throw new BrowserOriginError(origin, "timeout", "Browser origin approval expired");
    if (option === "deny")
      throw new BrowserOriginError(origin, "denied", "Browser origin approval denied");
    if (host.thread(threadId)?.thread.permission?.effective === "read-only")
      throw new BrowserOriginError(
        origin,
        "read_only",
        "Read-only mode refuses agent browser navigation",
      );
    if (option === "allow_thread") browser.originsGrant(threadId, origin, host.now());
    else browser.originsPageGrant(threadId, origin, host.now());
  });
}
