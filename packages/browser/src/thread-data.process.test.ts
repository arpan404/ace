import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sessionDirectories } from "./session-dirs-test-support.ts";
import { executablePath, fixture } from "./test-support.ts";

const Opened = z.object({ tabId: z.string() });

describe.skipIf(!executablePath)("a thread's browser data", () => {
  it("deleting a thread removes its session folder, downloads included, and leaves other threads'", async () => {
    const f = await fixture();
    await f.service.open({ threadId: "other", workspaceId: "workspace" });
    const [first, second] = await sessionDirectories(f.home);
    if (!first || !second) throw new Error("Session folders missing");
    for (const dir of [first, second])
      await writeFile(join(dir, "downloads", "report.pdf"), "downloaded bytes");

    await f.service.forgetThread("thread", "workspace");

    const left = await sessionDirectories(f.home);
    expect(left).toHaveLength(1);
    expect(await readdir(join(left[0] ?? "", "downloads"))).toEqual(["report.pdf"]);
    expect(f.service.hasActiveSession("other")).toBe(true);
  }, 60_000);

  it("a forked thread's browser opens with a copy of its parent's tabs under new ids", async () => {
    const f = await fixture({
      forkedFrom: (threadId) => (threadId === "fork" ? "thread" : undefined),
    });
    await f.navigate();
    await f.execute({ action: "tabs", operation: "open", url: `${f.url}/side`, label: "side" });
    const hidden = Opened.parse(
      await f.execute({ action: "tabs", operation: "open", url: `${f.url}/hidden` }),
    ).tabId;
    f.service.setPrivate("thread", hidden, true);
    const parent = f.service.state("thread").tabs ?? [];

    await f.service.open({ threadId: "fork", workspaceId: "workspace" });

    const fork = f.service.state("fork").tabs ?? [];
    // The person's private tab stays behind; the rest come with their addresses and labels.
    expect(fork.map((tab) => [tab.url, tab.label])).toEqual([
      [`${f.url}/`, undefined],
      [`${f.url}/side`, "side"],
    ]);
    const parentIds = new Set(parent.map((tab) => tab.tabId));
    for (const tab of fork) expect(parentIds.has(tab.tabId)).toBe(false);
    expect(
      await f.service.execute("fork", {
        action: "evaluate",
        tabId: fork[1]?.tabId,
        expression: "location.pathname",
      }),
    ).toBe("/side");
  }, 60_000);
});
