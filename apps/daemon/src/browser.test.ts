import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { detectChromium } from "@ace/browser";
import { BrowserFrame } from "@ace/protocol";
import { startDaemon } from "./index.ts";
import { readConfig } from "./config.ts";
import { createDevThread } from "./commands.ts";
import { BrowserClient } from "./browser-test-client.ts";
import { ownedBrowserPids, waitForBrowserExit } from "./browser-test-process.ts";

const executablePath = await detectChromium();
const exec = promisify(execFile);
describe.skipIf(!executablePath)("authenticated daemon browser wire", () => {
  it("streams to two authenticated clients, scopes control to a connection, and persists recordings as thread artifacts", async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-browser-wire-"));
    const daemon = await startDaemon(
      readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
      undefined,
      undefined,
      { ffmpeg: "/nonexistent/ffmpeg" },
    );
    const clients = [new BrowserClient(daemon.url), new BrowserClient(daemon.url)];
    try {
      const workspace = daemon.store.createWorkspace("/repo", "Repo");
      const thread = createDevThread(daemon.store, workspace);
      const token = await readFile(daemon.tokenPath, "utf8");
      const first = clients[0],
        second = clients[1];
      if (!first || !second) throw new Error("Missing clients");
      await Promise.all(clients.map((client) => client.hello(token)));
      expect(
        await first.request({
          type: "browser.open",
          requestId: "open",
          options: { threadId: thread.id, workspaceId: workspace },
        }),
      ).toMatchObject({ ok: true });
      expect(
        await second.request({
          type: "browser.takeover",
          requestId: "unknown",
          threadId: "unknown",
        }),
      ).toMatchObject({ ok: false, error: "Browser thread access denied" });
      const frames = clients.map((client) =>
        client.next((message) => message.type === "browser.frame"),
      );
      await Promise.all(
        clients.map((client, index) =>
          client.request({
            type: "browser.subscribe",
            requestId: `subscribe-${index}`,
            threadId: thread.id,
          }),
        ),
      );
      for (const reply of await Promise.all(frames)) {
        if (reply.type !== "browser.frame") throw new Error("Expected frame");
        expect(BrowserFrame.parse(reply.frame).data.length).toBeGreaterThan(0);
      }
      await first.request({ type: "browser.takeover", requestId: "take", threadId: thread.id });
      await expect(
        daemon.browser.execute(thread.id, { action: "scroll", x: 0, y: 1 }),
      ).rejects.toThrow("controlled by human");
      expect(
        await second.request({
          type: "browser.input",
          requestId: "inject",
          threadId: thread.id,
          input: { kind: "scroll", x: 0, y: 0, deltaX: 0, deltaY: 1 },
        }),
      ).toMatchObject({ ok: false, error: "Browser controller mismatch" });
      expect(
        await first.request({
          type: "browser.input",
          requestId: "owner",
          threadId: thread.id,
          input: { kind: "touch", event: "touchStart", points: [{ x: 10, y: 10, id: 0 }] },
        }),
      ).toMatchObject({ ok: true });
      expect(
        await first.request({
          type: "browser.input",
          requestId: "owner-end",
          threadId: thread.id,
          input: { kind: "touch", event: "touchEnd", points: [] },
        }),
      ).toMatchObject({ ok: true });
      await first.request({ type: "browser.handback", requestId: "back", threadId: thread.id });
      await first.request({
        type: "browser.recording.start",
        requestId: "start",
        threadId: thread.id,
      });
      const recording = await first.request({
        type: "browser.recording.stop",
        requestId: "stop",
        threadId: thread.id,
      });
      expect(recording).toMatchObject({ ok: true, result: { mimeType: "text/html" } });
      const item = daemon.store
        .readEvents({ afterSeq: 0, threadId: thread.id, limit: 20 })
        .find((event) => event.payload.type === "item.created");
      expect(item).toMatchObject({
        payload: {
          item: { type: "artifact", source: "browser", mimeType: "text/html", complete: true },
        },
      });
      if (item?.payload.type !== "item.created") throw new Error("Recording item missing");
      expect(item.payload.item.agentId).toBeUndefined();
      await daemon.close();
      expect((await exec("ps", ["-axo", "command"])).stdout).not.toContain(
        `--user-data-dir=${home}`,
      );
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await daemon.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "leaves no owned Chromium after daemon exit on %s",
    async (signal) => {
      const home = await mkdtemp(join(tmpdir(), "ace-browser-exit-"));
      const daemon = spawn(process.execPath, ["apps/daemon/src/cli.ts"], {
        env: {
          ...process.env,
          ACE_HOME: home,
          ACE_PORT: "0",
          ACE_LOG_LEVEL: "silent",
          ACE_DEV: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = once(daemon, "close");
      let output = "",
        errors = "";
      daemon.stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      const ready = new Promise<string>((resolve) =>
        daemon.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const url = /ace daemon: (ws:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
          if (url) resolve(url);
        }),
      );
      let client: BrowserClient | undefined;
      try {
        const url = await Promise.race([
          ready,
          exited.then(() => {
            throw new Error(errors);
          }),
        ]);
        client = new BrowserClient(url);
        await client.hello(await readFile(join(home, "daemon-token"), "utf8"));
        client.send({ type: "subscribe", subscriptionId: "threads", scope: { kind: "threads" } });
        const snapshot = await client.next((message) => message.type === "snapshot");
        const threads = z
          .object({
            view: z.object({
              threads: z.record(z.string(), z.object({ id: z.string(), workspaceId: z.string() })),
            }),
          })
          .parse(snapshot);
        const thread = Object.values(threads.view.threads)[0];
        if (!thread) throw new Error("Missing dev thread");
        const response = await client.request({
          type: "browser.open",
          requestId: "open",
          options: { threadId: thread.id, workspaceId: thread.workspaceId },
        });
        expect(response).toMatchObject({ ok: true });
        const pids = await ownedBrowserPids(home);
        expect(pids.length).toBeGreaterThan(0);
        daemon.kill(signal);
        expect((await exited)[0]).toBe(signal === "SIGTERM" ? 0 : null);
        await waitForBrowserExit(pids);
        expect(await ownedBrowserPids(home)).toEqual([]);
      } finally {
        if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
        await exited;
        await client?.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
