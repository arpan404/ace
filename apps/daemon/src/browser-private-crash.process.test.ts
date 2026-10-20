import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { detectChromium } from "@ace/browser";
import { BrowserState } from "@ace/protocol";
import { BrowserClient } from "./browser-test-client.ts";
import { ownedBrowserPids, waitForBrowserExit } from "./browser-test-process.ts";

const executablePath = await detectChromium();
let cancellation: AbortSignal;
beforeEach((context) => {
  cancellation = context.signal;
});
async function launch(home: string) {
  if (!executablePath) throw new Error("Missing explicit test Chromium");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./testing/browser-daemon.ts", import.meta.url)), executablePath],
    {
      env: {
        ...process.env,
        ACE_HOME: home,
        ACE_PORT: "0",
        ACE_LOG_LEVEL: "silent",
        ACE_DEV: "1",
        ACE_HISTORY_INSTANCES: "[]",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "close");
  let output = "",
    errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-8192);
  });
  const ready = new Promise<string>((resolve) =>
    child.stdout.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8192);
      const url = /ace daemon: (ws:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      if (url) resolve(url);
    }),
  );
  try {
    const url = await Promise.race([
      ready,
      exited.then(() => {
        throw new Error(errors);
      }),
    ]);
    const client = new BrowserClient(url);
    await client.hello(await readFile(join(home, "daemon-token"), "utf8"));
    return {
      child,
      exited,
      client,
      close: async () => {
        const pids = await ownedBrowserPids(home);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        await client.close();
        // The detached guardian outlives daemon exit while it stops profile writers.
        await waitForBrowserExit(pids, cancellation);
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  }
}

it.skipIf(!executablePath).each(["SIGKILL", "SIGTERM"] as const)(
  "a private tab stays private through a daemon %s and persistent browser reopening",
  async (signal) => {
    const home = await mkdtemp(join(tmpdir(), "ace-private crash-"));
    let first: Awaited<ReturnType<typeof launch>> | undefined,
      restarted: Awaited<ReturnType<typeof launch>> | undefined;
    let helper: ReturnType<typeof spawn> | undefined;
    try {
      first = await launch(home);
      first.client.send({
        type: "subscribe",
        subscriptionId: "threads",
        scope: { kind: "threads" },
      });
      const snapshot = z
        .object({
          view: z.object({
            threads: z.record(z.string(), z.object({ id: z.string(), workspaceId: z.string() })),
          }),
        })
        .parse(await first.client.next((message) => message.type === "snapshot"));
      const thread = Object.values(snapshot.view.threads)[0];
      if (!thread) throw new Error("thread");
      const request = {
        type: "browser.open",
        requestId: "open",
        options: {
          threadId: thread.id,
          workspaceId: thread.workspaceId,
          profile: "persistent",
          background: true,
        },
      };
      const opened = await first.client.request(request);
      if (opened.type !== "browser.result" || !opened.ok) throw new Error("open failed");
      const tabId = BrowserState.parse(opened.result).activeTabId;
      if (!tabId) throw new Error("No tab");
      const viewed = (state: unknown) =>
        BrowserState.parse(state).tabs?.find((tab) => tab.tabId === tabId);
      const made = await first.client.request({
        type: "browser.tabs.private",
        requestId: "private",
        threadId: thread.id,
        tabId,
        private: true,
      });
      if (made.type !== "browser.result" || !made.ok) throw new Error("private failed");
      expect(viewed(made.result)).toMatchObject({ private: true });
      // A detached private-profile helper deterministically survives its browser's
      // pipe EOF, just like Chromium's network helper did under load. The profile
      // owner must terminate it on both graceful and abrupt daemon shutdown.
      helper = await launchProfileHelper(home);
      const pids = await ownedBrowserPids(home);
      expect(pids).toContain(helper.pid);
      // The socket stays connected until process exit: no disconnect callback persists the gate.
      first.child.kill(signal);
      await first.exited;
      await waitForBrowserExit(pids, cancellation);
      restarted = await launch(home);
      const reply = await restarted.client.request(request);
      if (reply.type !== "browser.result" || !reply.ok) throw new Error("reopen failed");
      expect(viewed(reply.result)).toMatchObject({ private: true });
      const shared = await restarted.client.request({
        type: "browser.tabs.private",
        requestId: "release",
        threadId: thread.id,
        tabId,
        private: false,
      });
      if (shared.type !== "browser.result" || !shared.ok) throw new Error("release failed");
      expect(viewed(shared.result)?.private).toBeUndefined();
      // A surviving helper also exercises the restarted browser's final profile cleanup.
      helper = await launchProfileHelper(home);
      await restarted.close();
      expect(await ownedBrowserPids(home)).toEqual([]);
    } finally {
      await stopHelper(helper);
      await restarted?.close();
      await first?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  120_000,
);

async function launchProfileHelper(home: string) {
  const profile = join(home, "browser", "profile");
  const helper = spawn(
    process.execPath,
    [
      "-e",
      "require('node:net').createServer().listen(0, '127.0.0.1', () => process.send('ready'));",
      "--",
      `--user-data-dir=${profile}`,
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  try {
    expect((await once(helper, "message", { signal: cancellation }))[0]).toBe("ready");
    helper.disconnect();
    return helper;
  } catch (error) {
    await stopHelper(helper);
    throw error;
  }
}

async function stopHelper(helper: ReturnType<typeof spawn> | undefined) {
  if (!helper?.pid || helper.exitCode !== null || helper.signalCode !== null) return;
  const exited = once(helper, "exit");
  try {
    process.kill(-helper.pid, "SIGKILL");
  } catch (error) {
    if (!z.object({ code: z.literal("ESRCH") }).safeParse(error).success) throw error;
  }
  await exited;
}
