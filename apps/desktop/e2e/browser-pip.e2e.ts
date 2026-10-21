import { expect, it } from "vitest";
import { browserSandbox } from "./fixtures/browser-sandbox.ts";
import { nativePage } from "./fixtures/native-page.ts";

it.runIf(process.env.ACE_E2E_ELECTRON === "1")(
  "picture-in-picture draws the page's live video inside its box, and a click brings the page back",
  async () => {
    const s = await browserSandbox();
    const agent = { kind: "agent" } as const;
    let working: ReturnType<typeof setInterval> | undefined;
    try {
      const p = s.page;
      const threadId = s.thread.id;
      await p.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30000 });
      await s.daemon.browser.open({
        threadId,
        workspaceId: s.thread.workspaceId,
        background: true,
      });
      await s.daemon.browser.execute(threadId, { action: "navigate", url: s.url }, agent);
      const native = nativePage(s.app, p, s.url);
      const address = p.getByRole("combobox", { name: "Address" });
      await expect
        .poll(
          async () => {
            if (await address.isVisible()) return true;
            await p.keyboard.press("Control+Shift+B");
            return false;
          },
          { timeout: 30000, interval: 1000 },
        )
        .toBe(true);
      await expect.poll(native.placed, { timeout: 30000 }).toBe(true);
      // The agent keeps working in the page, so it follows the person out of the panel.
      working = setInterval(() => {
        void s.daemon.browser
          .execute(threadId, { action: "evaluate", expression: "1" }, agent)
          .catch(() => {});
      }, 1500);
      await p.getByRole("button", { name: "Right panel", exact: true }).click();
      const pip = p.getByRole("region", { name: /^Picture in picture/ });
      await pip.waitFor({ timeout: 20000 });
      // No native view in the window: it would paint over the app, past the box's edges.
      await expect.poll(async () => (await native.geometry()).native.visible).toBe(false);
      const picture = pip.getByRole("img", { name: `Live view of ${s.url}` });
      await picture.waitFor({ timeout: 20000 });
      const first = await drawn(picture);
      expect(first.inside).toBe(true);
      // The fixture animates every frame: the picture keeps moving.
      await expect
        .poll(async () => (await drawn(picture)).hash, { timeout: 10000 })
        .not.toBe(first.hash);
      await picture.click();
      await expect.poll(() => pip.count(), { timeout: 10000 }).toBe(0);
      await expect.poll(native.placed, { timeout: 10000 }).toBe(true);
      // Only × puts it away.
      await p.getByRole("button", { name: "Right panel", exact: true }).click();
      await pip.waitFor({ timeout: 20000 });
      await p.getByRole("button", { name: "Close picture in picture" }).click();
      await expect.poll(() => pip.count()).toBe(0);
    } catch (error) {
      await s.page.screenshot({ path: "/tmp/ace-pip-ui.png" });
      throw error;
    } finally {
      clearInterval(working);
      await s.close();
    }
  },
  240000,
);

/** A canvas's pixels as one number, and whether it sits inside its floating window. */
async function drawn(picture: import("playwright-core").Locator) {
  return picture.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) return { hash: 0, inside: false };
    const pixels =
      element.getContext("2d")?.getImageData(0, 0, element.width, element.height).data ?? [];
    let hash = 0;
    for (let i = 0; i < pixels.length; i += 4)
      hash = (hash * 31 + (pixels[i] ?? 0) + (pixels[i + 2] ?? 0) * 7) % 1_000_000_007;
    const box = element.getBoundingClientRect();
    const frame = element.closest("section")?.getBoundingClientRect();
    const inside =
      !!frame &&
      box.left >= frame.left &&
      box.top >= frame.top &&
      box.right <= frame.right &&
      box.bottom <= frame.bottom;
    return { hash, inside };
  });
}

it.runIf(process.env.ACE_E2E_ELECTRON === "1")(
  "two threads' agents browse at once: both pages stream live in their own windows",
  async () => {
    const s = await browserSandbox();
    const agent = { kind: "agent" } as const;
    const busy: ReturnType<typeof setInterval>[] = [];
    try {
      const p = s.page;
      await p.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30000 });
      const pages = [
        { thread: s.thread, url: s.url },
        { thread: s.other, url: `${s.url}second` },
      ];
      for (const { thread, url } of pages) {
        await s.daemon.browser.open({
          threadId: thread.id,
          workspaceId: thread.workspaceId,
          background: true,
        });
        await s.daemon.browser.execute(thread.id, { action: "navigate", url }, agent);
        busy.push(
          setInterval(() => {
            void s.daemon.browser
              .execute(thread.id, { action: "evaluate", expression: "1" }, agent)
              .catch(() => {});
          }, 1500),
        );
      }
      const address = p.getByRole("combobox", { name: "Address" });
      /**
       * The page shows in the panel: placed natively, or, under another thread's floating
       * window, drawn from its still and video there.
       */
      const shownInPanel = async (url: string) =>
        (await nativePage(s.app, p, url).placed()) ||
        (await p.locator("[data-browser-page] :is([data-frozen-page], canvas)").count()) > 0;
      /** Looks at the open thread's Browser in the panel, then closes the panel. */
      const lookAtBrowser = async (url: string) => {
        await expect
          .poll(
            async () => {
              if (await address.isVisible()) return true;
              await p.keyboard.press("Control+Shift+B");
              return false;
            },
            { timeout: 30000, interval: 1000 },
          )
          .toBe(true);
        await expect.poll(() => shownInPanel(url), { timeout: 30000 }).toBe(true);
        await p.getByRole("button", { name: "Right panel", exact: true }).click();
      };
      await lookAtBrowser(s.url);
      await p.getByRole("link", { name: /Other fixture/ }).click();
      await lookAtBrowser(`${s.url}second`);
      const windows = p.getByRole("region", { name: /^Picture in picture/ });
      await expect.poll(() => windows.count(), { timeout: 20000 }).toBe(2);
      for (const { url } of pages)
        await expect
          .poll(async () => (await nativePage(s.app, p, url).geometry()).native.visible)
          .toBe(false);
      const boxes = await windows.evaluateAll((sections) =>
        sections.map((section) => section.getBoundingClientRect().toJSON() as DOMRect),
      );
      const [a, b] = boxes;
      if (!a || !b) throw new Error("Two windows expected");
      const apart =
        a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      expect(apart).toBe(true);
      // Both pages animate every frame: both pictures keep moving, each inside its own box.
      for (const index of [0, 1]) {
        const picture = windows.nth(index).getByRole("img", { name: /^Live view of/ });
        await picture.waitFor({ timeout: 20000 });
        const first = await drawn(picture);
        expect(first.inside).toBe(true);
        await expect
          .poll(async () => (await drawn(picture)).hash, { timeout: 10000 })
          .not.toBe(first.hash);
      }
      // The first thread's window opens that thread with its Browser; the other keeps floating.
      await windows
        .filter({ hasText: "Browser fixture" })
        .getByRole("img", { name: /^Live view of/ })
        .click();
      await p.getByRole("heading", { level: 1, name: "Browser fixture" }).waitFor();
      await expect.poll(() => shownInPanel(s.url), { timeout: 10000 }).toBe(true);
      await expect.poll(() => windows.count()).toBe(1);
      await expect(windows.first().getByText("Other fixture").count()).resolves.toBe(1);
    } catch (error) {
      await s.page.screenshot({ path: "/tmp/ace-pip-threads-ui.png" });
      throw error;
    } finally {
      for (const timer of busy) clearInterval(timer);
      await s.close();
    }
  },
  240000,
);
