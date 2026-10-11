import { expect, it } from "vitest";
import { backendFixture } from "./backend-test-support.ts";

it.each([
  "shared",
  "private",
  "handback",
  "target change",
  "target round trip",
  "close",
  "disconnect",
])(
  "popup approval cannot navigate after %s changes its submitting page or lease",
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
    if (transition === "private") f.service.takeover("thread", "person", "private");
    else if (transition === "shared" || transition === "handback") {
      f.service.takeover("thread", "person");
      if (transition === "handback") f.service.handback("thread", "person");
    } else if (transition === "target change" || transition === "target round trip") {
      f.sendEvent(sessionId, "ace.tabs.changed", {
        activeTabId: "replacement",
        tabs: [
          { tabId: "replacement", url: "about:blank", title: "" },
          { tabId: "native-tab", url: "about:blank", title: "" },
        ],
      });
      await expect.poll(() => f.service.state("thread").activeTabId).toBe("replacement");
      if (transition === "target round trip") {
        f.sendEvent(sessionId, "ace.tabs.changed", {
          activeTabId: "native-tab",
          tabs: [
            { tabId: "replacement", url: "about:blank", title: "" },
            { tabId: "native-tab", url: "about:blank", title: "" },
          ],
        });
        await expect.poll(() => f.service.state("thread").activeTabId).toBe("native-tab");
      }
    } else if (transition === "close") await f.service.closeThread("thread");
    else await f.disconnect();
    approval.resolve(true);
    // A fresh public command is a barrier behind the admitted popup intent.
    if (transition !== "close" && transition !== "disconnect") {
      await f.service
        .execute("thread", { action: "snapshot" }, { kind: "human", connectionId: "person" })
        .catch(() => {});
    } else await new Promise<void>((resolve) => setImmediate(resolve));
    expect(navigations).toBe(0);
  },
);

it("an approved popup with an unchanged lease navigates the page that requested it", async () => {
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
