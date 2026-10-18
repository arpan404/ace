import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Actor } from "./session.ts";
import { defaultTabLifecycle } from "./tab-lifecycle.ts";
import { executablePath, fixture, ref } from "./test-support.ts";

const Opened = z.object({ tabId: z.string() });
const Tabs = z.object({
  activeTabId: z.string(),
  tabs: z.array(
    z.object({
      tabId: z.string(),
      url: z.string(),
      label: z.string().optional(),
      current: z.boolean().optional(),
      private: z.boolean().optional(),
      inUse: z.object({ kind: z.string(), agentId: z.string().optional() }).optional(),
    }),
  ),
});
const agent = (agentId: string): Actor => ({ kind: "agent", agentId });
const person: Actor = { kind: "human", connectionId: "person" };

describe.skipIf(!executablePath)("tabs in one thread's browser", () => {
  it("two agents work their own tabs at the same time without disturbing each other", async () => {
    const f = await fixture();
    const run = (agentId: string, command: unknown) =>
      f.service.execute("thread", command, agent(agentId));
    const a = Opened.parse(
      await run("a", { action: "tabs", operation: "open", url: f.url + "/a", label: "a" }),
    ).tabId;
    const b = Opened.parse(
      await run("b", { action: "tabs", operation: "open", url: f.url + "/b", label: "b" }),
    ).tabId;
    expect(a).not.toBe(b);
    // Neither agent names its tab: each command goes to the tab that agent opened.
    const work = async (agentId: string, text: string) => {
      const name = ref(await run(agentId, { action: "snapshot" }), "Name");
      await run(agentId, { action: "type", ref: name, text });
      await run(agentId, {
        action: "click",
        ref: ref(await run(agentId, { action: "snapshot" }), "Save"),
      });
      return run(agentId, {
        action: "evaluate",
        expression: "document.getElementById('result').textContent",
      });
    };
    const [fromA, fromB] = await Promise.all([work("a", "alpha"), work("b", "beta")]);
    expect([fromA, fromB]).toEqual(["alpha", "beta"]);
    expect(await run("a", { action: "evaluate", expression: "location.pathname" })).toBe("/a");
    expect(await run("b", { action: "evaluate", expression: "location.pathname" })).toBe("/b");
  }, 60_000);

  it("a slow command on one tab does not hold up another tab", async () => {
    const f = await fixture();
    const a = f.service.state("thread").activeTabId;
    const b = Opened.parse(
      await f.execute({ action: "tabs", operation: "open", url: f.url }),
    ).tabId;
    const finished: string[] = [];
    const slow = f.service
      .execute("thread", {
        action: "evaluate",
        tabId: a,
        expression: "new Promise((resolve) => setTimeout(() => resolve('slow'), 1500))",
      })
      .then(() => finished.push("slow"));
    await f.service.execute("thread", { action: "snapshot", tabId: b });
    finished.push("snapshot");
    await slow;
    expect(finished).toEqual(["snapshot", "slow"]);
  }, 60_000);

  it("a screenshot of another tab leaves the person's view where it is", async () => {
    const f = await fixture();
    await f.navigate();
    const viewed = f.service.state("thread").activeTabId;
    if (!viewed) throw new Error("No viewed tab");
    await f.service.execute(
      "thread",
      { action: "tabs", operation: "select", tabId: viewed },
      person,
    );
    const other = Opened.parse(
      await f.service.execute(
        "thread",
        { action: "tabs", operation: "open", url: f.url + "/other" },
        agent("worker"),
      ),
    ).tabId;
    expect(f.service.state("thread").activeTabId).toBe(viewed);
    const bytes = await f.service.screenshot("thread", undefined, other, { fullPage: true });
    expect(Buffer.from(bytes).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    await f.service.execute("thread", { action: "snapshot", tabId: other }, agent("worker"));
    expect(f.service.state("thread").activeTabId).toBe(viewed);
  }, 60_000);

  it("the person busy in one tab never slows an agent in another, which is marked in use", async () => {
    const f = await fixture();
    await f.navigate();
    const busy = f.service.state("thread").activeTabId;
    const free = Opened.parse(
      await f.service.execute(
        "thread",
        { action: "tabs", operation: "open", url: f.url },
        agent("worker"),
      ),
    ).tabId;
    await f.service.input("thread", { kind: "key", event: "char", key: "x" }, "person", busy);
    const freeName = ref(
      await f.service.execute("thread", { action: "snapshot", tabId: free }, agent("worker")),
      "Name",
    );
    const started = Date.now();
    await f.service.execute(
      "thread",
      { action: "type", tabId: free, ref: freeName, text: "yes" },
      agent("worker"),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    const tabs = Tabs.parse(await f.service.execute("thread", { action: "tabs" }, person)).tabs;
    expect(tabs.find((tab) => tab.tabId === free)).toMatchObject({
      inUse: { kind: "agent", agentId: "worker" },
    });
  }, 60_000);

  it("a private tab refuses agents while they keep working in another tab", async () => {
    const f = await fixture();
    await f.navigate();
    const hidden = f.service.state("thread").activeTabId;
    const open = Opened.parse(
      await f.service.execute(
        "thread",
        { action: "tabs", operation: "open", url: f.url + "/public" },
        agent("worker"),
      ),
    ).tabId;
    if (!hidden) throw new Error("No viewed tab");
    f.service.setPrivate("thread", hidden, true);
    for (const command of [
      { action: "snapshot", tabId: hidden },
      { action: "evaluate", tabId: hidden, expression: "document.title", mode: "read-only" },
    ])
      await expect(f.service.execute("thread", command, agent("worker"))).rejects.toMatchObject({
        code: "human_private",
      });
    await expect(f.service.screenshot("thread", undefined, hidden)).rejects.toMatchObject({
      code: "human_private",
    });
    expect(
      await f.service.execute(
        "thread",
        { action: "evaluate", tabId: open, expression: "location.pathname" },
        agent("worker"),
      ),
    ).toBe("/public");
    const listed = Tabs.parse(
      await f.service.execute("thread", { action: "tabs" }, agent("worker")),
    ).tabs.find((tab) => tab.tabId === hidden);
    expect(listed).toMatchObject({ url: "about:blank", private: true });
  }, 60_000);

  it("an agent can open eight tabs and no more, while another agent still can", async () => {
    const f = await fixture();
    const open = (agentId: string) =>
      f.service.execute("thread", { action: "tabs", operation: "open" }, agent(agentId));
    for (let count = 0; count < 8; count++) await open("busy");
    await expect(open("busy")).rejects.toMatchObject({ code: "tab_limit" });
    await open("other");
    const tabs = Tabs.parse(await f.service.execute("thread", { action: "tabs" }, agent("other")));
    expect(tabs.tabs).toHaveLength(10);
    expect(tabs.tabs.filter((tab) => tab.current)).toHaveLength(1);
  }, 120_000);

  it("the daemon-wide tab budget refuses a tab past it", async () => {
    const f = await fixture({ maxTabs: 2 });
    await f.execute({ action: "tabs", operation: "open" });
    await expect(f.execute({ action: "tabs", operation: "open" })).rejects.toMatchObject({
      code: "tab_limit",
    });
    expect(f.service.state("thread").tabs).toHaveLength(2);
  }, 60_000);

  it("closing an agent's tab leaves the others, and closing the last tab closes the browser", async () => {
    const f = await fixture();
    const first = f.service.state("thread").activeTabId;
    const second = Opened.parse(await f.execute({ action: "tabs", operation: "open" })).tabId;
    await f.execute({ action: "tabs", operation: "close", tabId: second });
    expect(f.service.state("thread").tabs?.map((tab) => tab.tabId)).toEqual([first]);
    await expect(f.execute({ action: "snapshot", tabId: second })).rejects.toMatchObject({
      code: "tab_not_found",
    });
    await f.execute({ action: "tabs", operation: "close", tabId: first });
    expect(() => f.service.state("thread")).toThrow("not open");
  }, 60_000);

  it("an idle background tab freezes, and the next command on it wakes it first", async () => {
    let now = 0;
    const ticks: (() => void)[] = [];
    const f = await fixture({
      now: () => now,
      tabLifecycle: {
        policy: defaultTabLifecycle,
        every: 60_000,
        set: (_delay, work) => {
          ticks.push(work);
          return () => {};
        },
      },
    });
    const idle = f.service.state("thread").activeTabId;
    await f.execute({ action: "navigate", url: f.url, tabId: idle });
    await f.execute({ action: "tabs", operation: "open" });
    const lifecycle = () =>
      f.service.state("thread").tabs?.find((tab) => tab.tabId === idle)?.lifecycle;
    now = defaultTabLifecycle.freezeAfterMs + 1;
    ticks.shift()?.();
    await expect.poll(lifecycle).toBe("frozen");
    expect(
      await f.execute({ action: "evaluate", tabId: idle, expression: "document.visibilityState" }),
    ).toBeTypeOf("string");
    expect(lifecycle()).toBe("live");
  }, 60_000);
});
