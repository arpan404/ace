import { chromium, type Page } from "playwright-core";
import { expect, it } from "vitest";
import { HeadlessBackend } from "./index.ts";
import { executablePath, fixture } from "./test-support.ts";

async function popupFixture() {
  const started = Promise.withResolvers<void>();
  const approval = Promise.withResolvers<boolean>();
  const navigations: Promise<unknown>[] = [];
  let original: Page | undefined;
  const observe = (page: Page) => {
    original ??= page;
    const goto = page.goto.bind(page);
    // Observe real I/O completion so the URL assertion cannot race a late load.
    page.goto = (...args) => {
      const navigation = goto(...args);
      navigations.push(navigation.catch(() => {}));
      return navigation;
    };
  };
  const f = await fixture({
    origins: { list: () => [], grant() {}, revoke() {} },
    originPolicy: (request) => {
      if (!request.url.endsWith("/popup")) return true;
      started.resolve();
      return approval.promise;
    },
    headlessBackend: new HeadlessBackend(
      async () => {
        if (!executablePath) throw new Error("Chromium unavailable");
        return executablePath;
      },
      async (profile, options) => {
        const context = await chromium.launchPersistentContext(profile, options);
        context.pages().forEach(observe);
        context.on("page", observe);
        return context;
      },
    ),
  });
  await f.navigate();
  await f.evaluate(`void window.open(${JSON.stringify(f.url + "/popup")})`);
  await started.promise;
  if (!original) throw new Error("No headless page");
  return { ...f, original, approval, navigations };
}

it.skipIf(!executablePath).each(["shared", "private", "handback", "disconnect"])(
  "a headless popup approval cannot navigate after %s changes its submitting lease",
  async (transition) => {
    const f = await popupFixture();
    f.service.takeover("thread", "person", transition === "private" ? "private" : "shared");
    if (transition === "handback") f.service.handback("thread", "person");
    else if (transition === "disconnect") f.service.disconnect("person");
    f.approval.resolve(true);
    await f.service
      .execute(
        "thread",
        { action: "snapshot" },
        {
          kind: "human",
          connectionId: "person",
        },
      )
      .catch(() => {});
    await Promise.all(f.navigations);
    expect(f.original.url()).toBe(f.url + "/");
    expect(f.service.state("thread").url).toBe(f.url + "/");
  },
);

it.skipIf(!executablePath)(
  "an unchanged headless popup lease reaches its approved page",
  async () => {
    const f = await popupFixture();
    const tab = f.service.state("thread").activeTabId;
    f.approval.resolve(true);
    await expect.poll(() => f.service.state("thread").url).toBe(f.url + "/popup");
    expect(f.original.url()).toBe(f.url + "/popup");
    expect(f.service.state("thread").activeTabId).toBe(tab);
    expect(f.service.state("thread").tabs).toHaveLength(1);
  },
);
