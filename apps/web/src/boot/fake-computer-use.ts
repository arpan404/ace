import type { FakeDaemon } from "@ace/fake-daemon";
import type { ScreenOperation } from "@ace/protocol";

/*
 * `aceFakeWorld = "computer-use"` (set before boot, as the screens do): agents at work on this
 * Mac in the fake daemon. Three apps held by thread agents (one capturing in the background, one
 * the person has taken over), an app request waiting in a thread, and the cold-start thread's
 * browser with several agent tabs, a pending question, a flagged download and a script grant.
 * Fake pictures are fixtures, never the person's screen.
 */
export function seedComputerUse(daemon: FakeDaemon): void {
  const connection = daemon.screen.connection(() => {});
  let requests = 0;
  const call = (operation: ScreenOperation) =>
    connection.request({ type: "screen.request", requestId: `seed-${++requests}`, operation });
  const agent = (threadId: string) => {
    const snapshot = daemon.snapshot({ kind: "thread", threadId: threadId as never }) as {
      thread?: { rootAgentId?: string };
    };
    const agentId = snapshot.thread?.rootAgentId;
    return agentId ? { threadId, agentId } : undefined;
  };
  const sessions = new Map<string, string>();
  const seeded = daemon.screen.connection((message) => {
    if (message instanceof Uint8Array || message.type !== "screen.result" || !message.ok) return;
    const data = message.data as { sessionId?: string; target?: { bundleId?: string } } | undefined;
    if (data?.sessionId && data.target?.bundleId)
      sessions.set(data.target.bundleId, data.sessionId);
  });
  const start = (bundleId: string) =>
    seeded.request({
      type: "screen.request",
      requestId: `start-${++requests}`,
      operation: { op: "start", target: { kind: "app", bundleId }, fps: 10 },
    });
  void (async () => {
    await call({ op: "enable", enabled: true });
    for (const bundleId of [
      "com.apple.TextEdit",
      "com.apple.calculator",
      "com.apple.iphonesimulator",
    ])
      await call({ op: "approve", bundleId, allowed: true, scope: "always" });
    await call({
      op: "approve",
      bundleId: "com.apple.systempreferences",
      allowed: true,
      scope: "always",
    });
    for (const bundleId of [
      "com.apple.TextEdit",
      "com.apple.calculator",
      "com.apple.iphonesimulator",
    ])
      await start(bundleId);
    const holders = [
      agent("thread-cold-start"),
      agent("thread-dedupe"),
      agent("thread-cold-start"),
    ];
    const bundles = ["com.apple.TextEdit", "com.apple.iphonesimulator", "com.apple.calculator"];
    for (const [index, bundleId] of bundles.entries()) {
      const sessionId = sessions.get(bundleId);
      const holder = holders[index];
      if (!sessionId || !holder) continue;
      await call({ op: "controller", sessionId, controller: "agent", ...holder });
    }
    // The person took Calculator over from its agent.
    const calculator = sessions.get("com.apple.calculator");
    if (calculator) await call({ op: "controller", sessionId: calculator, controller: "human" });
    const asker = agent("thread-dedupe");
    if (asker)
      void daemon.screen
        .requestApp("com.apple.Notes", "Copy the release checklist into the shared note", asker)
        .catch(() => {});
  })();
  seedBrowser(daemon, "thread-cold-start");
}

function seedBrowser(daemon: FakeDaemon, threadId: string) {
  const { browser } = daemon;
  try {
    browser.tabOpen(threadId, "https://docs.stripe.com/payments/checkout");
    browser.tabOpen(threadId, "https://status.example.com/");
    const tabId = browser.view(threadId)?.activeTabId ?? "";
    browser.dialogOpen(threadId, {
      dialogId: "seed-dialog",
      tabId,
      type: "confirm",
      message: "Leave the incident page? Unsaved notes will be lost.",
    });
    browser.downloadAdd(threadId, {
      downloadId: "seed-download-1",
      tabId,
      filename: "status-export-2026-10.csv",
      bytes: 182_400,
      mimeType: "text/csv",
      flags: [],
      state: "complete",
      path: "/Users/dev/.ace-next/artifacts/status-export-2026-10.csv",
    });
    browser.downloadAdd(threadId, {
      downloadId: "seed-download-2",
      tabId,
      filename: "statuscli-installer.pkg",
      bytes: 24_800_000,
      mimeType: "application/octet-stream",
      flags: ["executable"],
      state: "pending",
    });
    browser.evaluateGrant(threadId, {
      origin: "https://status.example.com",
      mode: "read-only",
      grantedAt: Date.now() - 60_000,
    });
  } catch {
    // The thread's browser isn't open in this world.
  }
}
