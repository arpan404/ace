import type { FakeBrowser } from "./browser.ts";
import type { FakeServiceContext } from "./service-context.ts";

/** A private takeover holds the thread on a person, as in the daemon, until explicit handback. */
export function bindFakeBrowserPrivate(browser: FakeBrowser, host: FakeServiceContext): void {
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
}
