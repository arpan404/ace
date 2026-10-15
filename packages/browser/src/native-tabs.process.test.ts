import { expect, it } from "vitest";
import { z } from "zod";
import { backendFixture } from "./backend-test-support.ts";

const tabs = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    tabId: `tab-${index + 1}`,
    url: `https://example.test/${index + 1}`,
    title: `Tab ${index + 1}`,
  }));

async function nativeSession() {
  const f = await backendFixture({}, { nativeTabs: true });
  await f.open();
  const sessionId = f.pages.keys().next().value;
  if (!sessionId) throw new Error("No native page");
  return { f, sessionId };
}

it("tab changes stay in sync with 12 open tabs", async () => {
  const { f, sessionId } = await nativeSession();
  f.sendEvent(sessionId, "ace.tabs.changed", { activeTabId: "tab-12", tabs: tabs(12) });
  await expect.poll(() => f.service.state("thread").tabs?.length).toBe(12);
  expect(f.service.state("thread").activeTabId).toBe("tab-12");
  expect(f.service.state("thread").url).toBe("https://example.test/12");

  // Closing one of many tabs and switching to another is still reflected.
  const remaining = tabs(12).filter((tab) => tab.tabId !== "tab-12");
  f.sendEvent(sessionId, "ace.tabs.changed", { activeTabId: "tab-3", tabs: remaining });
  await expect.poll(() => f.service.state("thread").activeTabId).toBe("tab-3");
  expect(f.service.state("thread").tabs?.map((tab) => tab.tabId)).toEqual(
    remaining.map((tab) => tab.tabId),
  );
});

it("a malformed tab entry is skipped and reported while the other tabs stay in sync", async () => {
  const { f, sessionId } = await nativeSession();
  const longUrl = `https://example.test/${"a".repeat(9000)}`;
  f.sendEvent(sessionId, "ace.tabs.changed", {
    activeTabId: "tab-2",
    tabs: [
      ...tabs(10),
      { url: "https://example.test/no-id", title: "No id" },
      { tabId: "long", url: longUrl, title: "Long" },
    ],
  });
  await expect.poll(() => f.service.state("thread").tabs?.length).toBe(11);
  const state = f.service.state("thread");
  expect(state.activeTabId).toBe("tab-2");
  expect(state.tabs?.find((tab) => tab.tabId === "long")?.url).toBe(longUrl.slice(0, 8192));
  const logs = z
    .object({ entries: z.array(z.object({ text: z.string() })) })
    .parse(await f.service.execute("thread", { action: "logs" }));
  expect(logs.entries.some((entry) => entry.text.includes("malformed and skipped"))).toBe(true);
});

it("more than eight threads can hold a browser page at the same time", async () => {
  const f = await backendFixture();
  const opened = await Promise.all(
    Array.from({ length: 12 }, (_, index) => f.open(`thread-${index}`)),
  );
  expect(opened.every((state) => !state.closed)).toBe(true);
  expect(f.pages.size).toBe(12);
});

it("an agent can give a navigation two minutes to load", async () => {
  const { f } = await nativeSession();
  const state = await f.service.execute(
    "thread",
    { action: "navigate", url: "http://localhost:3000/slow", timeout: 120_000 },
    { kind: "agent" },
  );
  expect(z.object({ url: z.string() }).parse(state).url).toBe("http://localhost:3000/slow");
});
