import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { executablePath, fixture } from "./test-support.ts";

const exec = promisify(execFile);
describe.skipIf(!executablePath)("browser lifecycle and recordings", () => {
  it("closes while an approval hook is still waiting and rejects that pending operation", async () => {
    const { promise: entered, resolve: notify } = Promise.withResolvers<void>();
    const { promise: gate } = Promise.withResolvers<boolean>();
    const f = await fixture({
      evaluatePolicy: () => {
        notify();
        return gate;
      },
    });
    await f.navigate();
    const rejected = expect(f.evaluate("1")).rejects.toThrow("shutting down");
    await entered;
    await f.service.close();
    await rejected;
    expect((await exec("ps", ["-axo", "command"])).stdout).not.toContain(
      `--user-data-dir=${f.home}`,
    );
  }, 60_000);

  it("limits active sessions without replacing the running browser", async () => {
    const f = await fixture({ maxSessions: 1 });
    await f.navigate();
    await expect(f.service.open({ threadId: "second", workspaceId: "other" })).rejects.toThrow(
      "All browser pages are in use",
    );
    expect(f.service.state("thread").url).toBe(`${f.url}/`);
    expect(await f.evaluate("document.querySelector('input').getAttribute('aria-label')")).toBe(
      "Name",
    );
  }, 60_000);
  it("persistent threads share ace's profile across browser restarts, private threads do not", async () => {
    const f = await fixture({ chrome: { idleMs: 0 } });
    await f.navigate();
    await f.evaluate("localStorage.setItem('retained','yes')");
    await f.service.open({ threadId: "second", workspaceId: "other", profile: "persistent" });
    await f.service.execute("second", { action: "navigate", url: f.url });
    const read = { action: "evaluate", expression: "localStorage.getItem('retained')" };
    expect(await f.service.execute("second", read)).toBe("yes");
    await f.service.open({ threadId: "private", workspaceId: "workspace", profile: "ephemeral" });
    await f.service.execute("private", { action: "navigate", url: f.url });
    expect(await f.service.execute("private", read)).toBe(null);
    for (const thread of ["thread", "second", "private"]) await f.service.closeThread(thread);
    await vi.waitFor(
      async () =>
        expect((await exec("ps", ["-axo", "pid,command"])).stdout).not.toContain(
          `--user-data-dir=${f.home}`,
        ),
      { timeout: 30_000, interval: 100 },
    );
    await f.service.open({ threadId: "thread", workspaceId: "workspace" });
    await f.navigate();
    expect(await f.evaluate("localStorage.getItem('retained')")).toBe("yes");
    // This exercises two real browser lifetimes, including graceful shutdown.
  }, 120_000);
});
