import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { promisify } from "node:util";
import { z } from "zod";
import type { CdpSend } from "./cdp-connection.ts";
import { executablePath, fixture } from "./test-support.ts";

const exec = promisify(execFile);

describe.skipIf(!executablePath)("injected browser process boundaries", () => {
  it("passes an embedder's extra launch flags to ace's Chrome", async () => {
    const f = await fixture({ chrome: { args: ["--user-agent=ace-injected-agent"] } });
    expect(await f.evaluate("navigator.userAgent")).toBe("ace-injected-agent");
  }, 60_000);

  it("closes a thread even when the screencast stop is never answered", async () => {
    const f = await fixture({
      chrome: {
        intercept: {
          send: (send) => (method, params, sessionId) =>
            method === "Page.stopScreencast"
              ? new Promise(() => {})
              : send(method, params, sessionId),
        },
      },
    });
    await f.service.closeThread("thread");
    expect(() => f.service.state("thread")).toThrow("not open");
    await f.service.close();
    expect((await exec("ps", ["-axo", "command"])).stdout).not.toContain(
      `--user-data-dir=${f.home}`,
    );
  }, 60_000);
});

it.skipIf(!executablePath)(
  "closing the last Chromium page publishes closed state and permits reopening",
  async () => {
    const pages: string[] = [];
    let wire: CdpSend | undefined;
    const f = await fixture({
      chrome: {
        intercept: {
          send: (send) => {
            wire = send;
            return send;
          },
          event: (method, params, sessionId) => {
            const attached = z
              .object({ targetInfo: z.object({ targetId: z.string(), type: z.literal("page") }) })
              .safeParse(params);
            if (method === "Target.attachedToTarget" && !sessionId && attached.success)
              pages.push(attached.data.targetInfo.targetId);
          },
        },
      },
    });
    const page = pages.at(-1);
    if (!page || !wire) throw new Error("Missing page");
    await wire("Target.closeTarget", { targetId: page });
    await vi.waitFor(() => expect(() => f.service.state("thread")).toThrow("not open"));
    await f.service.open({ threadId: "thread", workspaceId: "workspace" });
    await f.navigate();
    expect(f.service.state("thread").url).toBe(f.url + "/");
  },
);
