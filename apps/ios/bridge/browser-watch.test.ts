import { afterEach, describe, expect, test } from "vitest";
import { closeBrowserFixtures, liveBrowser, viewport } from "./browser-fixture.ts";
import { type RecordingSink, until } from "./sheet-fixture.ts";

afterEach(closeBrowserFixtures);

type View = { watch?: { on: boolean } | null; state?: { activeTabId: string | null } | null };
const view = (sink: RecordingSink) => sink.read("browser:view") as View | undefined;
const shown = (sink: RecordingSink) => view(sink)?.state?.activeTabId;

/** The browser view with the thread's status in the test's hands. */
async function live(initial: string | undefined = "working") {
  let status: string | undefined = initial;
  const listeners = new Set<() => void>();
  const fixture = await liveBrowser({
    context: {
      threadState: () => status,
      observeThreads: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  const setStatus = (next: string | undefined) => {
    status = next;
    for (const listener of listeners) listener();
  };
  return { ...fixture, setStatus };
}

describe("Watch mode", () => {
  test("follows the agent from tab to tab, then ends once the agents stop working", async () => {
    const { daemon, sink, view: browser, setStatus } = await live();
    const agentsTab = daemon.browser.view("web")?.activeTabId;
    const mine = daemon.browser.personOpen("web", "https://docs.test/");
    browser.action({ kind: "open", threadId: "web", viewport });
    await until(() => shown(sink) === mine, "the person's tab shown");
    expect(view(sink)?.watch).toEqual({ on: false });

    expect(browser.action({ kind: "watch", on: true })).toBe(true);
    await until(() => shown(sink) === agentsTab, "the agent's tab shown");
    expect(view(sink)?.watch).toEqual({ on: true });

    daemon.browser.agentIdle("web", agentsTab);
    const next = daemon.browser.tabOpen("web", "https://shop.test/pay");
    await until(() => shown(sink) === next, "followed to the agent's new tab");

    setStatus("finished");
    await until(() => view(sink)?.watch === null, "watch mode ended");
  });

  test("is offered only while an agent uses a tab", async () => {
    const { daemon, sink, view: browser } = await live();
    daemon.browser.agentIdle("web");
    browser.action({ kind: "open", threadId: "web", viewport });
    await until(() => shown(sink) != null, "browser state");
    expect(view(sink)?.watch).toBeNull();
    browser.action({ kind: "watch", on: true });
    expect(view(sink)?.watch).toBeNull();
  });

  test("turning it off leaves the page where it is", async () => {
    const { daemon, sink, view: browser } = await live();
    const agentsTab = daemon.browser.view("web")?.activeTabId ?? "";
    browser.action({ kind: "open", threadId: "web", viewport });
    await until(() => shown(sink) === agentsTab, "browser state");
    browser.action({ kind: "watch", on: true });
    browser.action({ kind: "watch", on: false });
    expect(view(sink)?.watch).toEqual({ on: false });
    const mine = daemon.browser.personOpen("web");
    await until(() => shown(sink) === mine, "the person's tab");
    daemon.browser.agentWorks("web", { tabId: agentsTab });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(shown(sink)).toBe(mine);
  });

  test("isn't offered or started once the agents have stopped, though their tab keeps its mark", async () => {
    const { daemon, sink, view: browser } = await live("finished");
    const agentsTab = daemon.browser.view("web")?.activeTabId;
    const mine = daemon.browser.personOpen("web", "https://docs.test/");
    browser.action({ kind: "open", threadId: "web", viewport });
    await until(() => shown(sink) === mine, "the person's tab shown");
    expect(daemon.browser.view("web")?.tabs?.find((tab) => tab.tabId === agentsTab)?.inUse).toEqual(
      {
        kind: "agent",
      },
    );
    expect(view(sink)?.watch).toBeNull();
    browser.action({ kind: "watch", on: true });
    expect(view(sink)?.watch).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(shown(sink)).toBe(mine);
  });

  test("a reconnect's snapshot of a thread that stopped meanwhile ends it", async () => {
    // Turned on before the thread list had loaded: the status isn't known yet.
    const { daemon, sink, view: browser, setStatus } = await live(undefined);
    const agentsTab = daemon.browser.view("web")?.activeTabId;
    browser.action({ kind: "open", threadId: "web", viewport });
    await until(() => shown(sink) === agentsTab, "browser state");
    browser.action({ kind: "watch", on: true });
    expect(view(sink)?.watch).toEqual({ on: true });
    // The list loads after a reconnect, the run already over; the same reading again changes nothing.
    setStatus("finished");
    setStatus("finished");
    expect(view(sink)?.watch).toBeNull();
  });
});
