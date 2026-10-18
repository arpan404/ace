import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Actor } from "./session.ts";
import { executablePath, fixture } from "./test-support.ts";

const Opened = z.object({ tabId: z.string() });
const Tabs = z.object({
  activeTabId: z.string(),
  tabs: z.array(z.object({ tabId: z.string(), kept: z.boolean().optional() })),
});
const agent = (agentId: string): Actor => ({ kind: "agent", agentId });
const person: Actor = { kind: "human", connectionId: "person" };

describe.skipIf(!executablePath)("agent tabs when an agent's turn ends", () => {
  it("a temporary tab closes at the end of the agent's turn while its kept tab stays", async () => {
    const f = await fixture();
    const first = f.service.state("thread").activeTabId;
    if (!first) throw new Error("No first tab");
    // The person picks the first tab, so the agent's tabs open behind it.
    await f.service.execute(
      "thread",
      { action: "tabs", operation: "select", tabId: first },
      person,
    );
    const open = async (extra: Record<string, unknown> = {}) =>
      Opened.parse(
        await f.service.execute(
          "thread",
          { action: "tabs", operation: "open", url: f.url, ...extra },
          agent("worker"),
        ),
      ).tabId;
    const scratch = await open();
    const deliverable = await open({ keep: true });
    const handoff = await open();
    await f.service.execute(
      "thread",
      { action: "tabs", operation: "keep", tabId: handoff },
      agent("worker"),
    );
    const read = await open();
    // The person used this one: they may still be reading it.
    await f.service.input("thread", { kind: "key", event: "char", key: "x" }, "person", read);
    const other = Opened.parse(
      await f.service.execute(
        "thread",
        { action: "tabs", operation: "open", url: f.url },
        agent("someone-else"),
      ),
    ).tabId;

    await f.service.agentFinished("thread", "worker");

    const ids = Tabs.parse(f.service.state("thread")).tabs.map((tab) => tab.tabId);
    expect(ids).not.toContain(scratch);
    expect(ids).toEqual(expect.arrayContaining([first, deliverable, handoff, read, other]));
    const listed = Tabs.parse(
      await f.service.execute("thread", { action: "tabs" }, agent("someone-else")),
    );
    expect(listed.tabs.find((tab) => tab.tabId === deliverable)?.kept).toBe(true);
  }, 60_000);

  it("a finished agent's tab no longer pushes the next agent into an extra tab", async () => {
    const f = await fixture();
    await f.navigate();
    // The first agent works in the shown tab, which makes it that agent's current tab.
    await f.service.execute("thread", { action: "snapshot" }, agent("first"));
    await f.service.agentFinished("thread", "first");
    // The next agent lands on the same tab instead of being given a new one.
    await f.service.execute("thread", { action: "snapshot" }, agent("second"));
    expect(Tabs.parse(f.service.state("thread")).tabs).toHaveLength(1);
  }, 60_000);
});
