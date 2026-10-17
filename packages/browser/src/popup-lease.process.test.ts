import { expect, it } from "vitest";
import { backendFixture } from "./backend-test-support.ts";

it.each(["close", "disconnect"])(
  "popup approval cannot navigate after %s changes its submitting page",
  async (transition) => {
    const started = Promise.withResolvers<void>();
    const approval = Promise.withResolvers<boolean>();
    const f = await backendFixture(
      {
        originPolicy: (request) => {
          if (request.origin === "https://popup.example") {
            started.resolve();
            return approval.promise;
          }
          return true;
        },
      },
      { nativeTabs: true },
    );
    await f.open();
    const sessionId = f.pages.keys().next().value;
    if (!sessionId) throw new Error("No native page");
    let navigations = 0;
    f.requests.on("Page.navigate", () => {
      navigations++;
    });
    f.sendEvent(sessionId, "ace.popupRequested", {
      tabId: "native-tab",
      url: "https://popup.example/late",
    });
    await started.promise;
    if (transition === "close") await f.service.closeThread("thread");
    else await f.disconnect();
    approval.resolve(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(navigations).toBe(0);
  },
);

it("an approved popup navigates the page that requested it", async () => {
  const f = await backendFixture({ originPolicy: () => true }, { nativeTabs: true });
  await f.open();
  const sessionId = f.pages.keys().next().value;
  if (!sessionId) throw new Error("No native page");
  f.sendEvent(sessionId, "ace.popupRequested", {
    tabId: "native-tab",
    url: "https://popup.example/current",
  });
  await expect.poll(() => f.service.state("thread").url).toBe("https://popup.example/current");
  expect(f.service.state("thread").activeTabId).toBe("native-tab");
});

it("a popup still loads in the tab that asked for it after the person views another tab", async () => {
  const started = Promise.withResolvers<void>();
  const approval = Promise.withResolvers<boolean>();
  const f = await backendFixture(
    {
      originPolicy: (request) => {
        if (request.origin !== "https://popup.example") return true;
        started.resolve();
        return approval.promise;
      },
    },
    { nativeTabs: true },
  );
  await f.open();
  const sessionId = f.pages.keys().next().value;
  if (!sessionId) throw new Error("No native page");
  let navigations = 0;
  f.requests.on("Page.navigate", () => {
    navigations++;
  });
  f.sendEvent(sessionId, "ace.popupRequested", {
    tabId: "native-tab",
    url: "https://popup.example/late",
  });
  await started.promise;
  f.sendEvent(sessionId, "ace.tabs.changed", {
    activeTabId: "replacement",
    tabs: [
      { tabId: "replacement", url: "about:blank", title: "" },
      { tabId: "native-tab", url: "about:blank", title: "" },
    ],
  });
  await expect.poll(() => f.service.state("thread").activeTabId).toBe("replacement");
  approval.resolve(true);
  await expect.poll(() => navigations).toBe(1);
});
