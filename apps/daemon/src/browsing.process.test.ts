import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectChromium } from "@ace/browser";
import { readConfig, startDaemon } from "./index.ts";
import { createDevThread } from "./commands.ts";
import { BrowserClient } from "./browser-test-client.ts";

const executablePath = await detectChromium();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

describe.skipIf(!executablePath)("which threads an agent browses in", () => {
  it("a client hears which threads an agent is browsing in, and hears it again when the agent stops", async () => {
    if (!executablePath) throw new Error("Missing test Chromium");
    const home = await mkdtemp(join(tmpdir(), "ace-browsing-"));
    const daemon = await startDaemon({
      config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
      browser: {
        executablePath,
        collaboration: {
          quietMs: 1_500,
          maxWaitMs: 10_000,
          inUseMs: 200,
          followAfterMs: 30_000,
          presentMs: 30_000,
        },
      },
    });
    const workspace = daemon.store.createWorkspace(home, "Repo");
    const thread = createDevThread(daemon.store, workspace);
    const quiet = createDevThread(daemon.store, workspace);
    const client = new BrowserClient(daemon.url);
    cleanups.push(async () => {
      await client.close();
      await daemon.browser.closeThread(thread.id);
      await daemon.browser.closeThread(quiet.id);
      await daemon.close();
      await rm(home, { recursive: true, force: true });
    });
    await client.hello(await readFile(daemon.tokenPath, "utf8"));
    client.send({ type: "browser.browsing.watch", requestId: "watch" });
    expect(await client.next((message) => message.type === "browser.browsing")).toEqual({
      type: "browser.browsing",
      threads: [],
    });

    // A person's own browser in another thread is not an agent browsing.
    await daemon.browser.open({ threadId: quiet.id, workspaceId: workspace });
    await daemon.browser.open({ threadId: thread.id, workspaceId: workspace, background: true });
    const agent = { kind: "agent" as const, agentId: "root" };
    await daemon.browser.execute(thread.id, { action: "snapshot" }, agent);
    expect(
      await client.next(
        (message) => message.type === "browser.browsing" && message.threads.length > 0,
      ),
    ).toEqual({ type: "browser.browsing", threads: [thread.id] });

    // Once the agent's mark leaves its tab, the thread is no longer browsing.
    expect(
      await client.next(
        (message) => message.type === "browser.browsing" && message.threads.length === 0,
      ),
    ).toEqual({ type: "browser.browsing", threads: [] });
  });
});
