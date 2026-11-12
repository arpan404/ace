import { expect, test } from "vitest";
import { BrowserState } from "@ace/protocol";
import { browserViewState } from "./browser-view.ts";
import { plainPreview } from "./sheet-fixture.ts";

test("continuation exposes tabs after the initial twenty", () => {
  const state = BrowserState.parse({
    threadId: "web",
    url: "about:blank",
    closed: false,
    tabs: Array.from({ length: 21 }, (_, index) => ({
      tabId: `tab-${index}`,
      url: "about:blank",
      title: `Tab ${index}`,
    })),
  });
  const context = { preview: plainPreview, agentName: () => "Agent", navigation: undefined };
  expect(browserViewState(state, context).tabs).toHaveLength(20);
  const continued = browserViewState(state, { ...context, tabsLimit: 40 });
  expect(continued.tabs.at(-1)?.id).toBe("tab-20");
  expect(continued.moreTabs).toBe(0);
});
